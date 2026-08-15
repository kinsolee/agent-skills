#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import YAML from "yaml";

const API_BASE = "https://api.weixin.qq.com/cgi-bin";
const TOKEN_REFRESH_CODES = new Set([40001, 40014, 42001]);
const MAX_TITLE_CHARS = 32;
const MAX_AUTHOR_CHARS = 16;
const MAX_DIGEST_CHARS = 120;
const MAX_SOURCE_URL_BYTES = 1024;
const MAX_CONTENT_CHARS = 20_000;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
const PRODUCTION_NOTE_RE = /^\s*【(?:截图|录屏|动录|配图|本地截图)[^】]*】(?:\s*→.*)?\s*$/gmu;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu;
let cachedAccessToken = null;

export class InputError extends Error {
    constructor(message) {
        super(message);
        this.name = "InputError";
    }
}

export class WechatApiError extends Error {
    constructor(action, payload = {}) {
        const code = Number.isInteger(payload.errcode) ? payload.errcode : null;
        const detail = typeof payload.errmsg === "string" ? payload.errmsg : "unknown error";
        const rid = typeof payload.rid === "string" ? payload.rid : null;
        super(`${action}失败${code === null ? "" : ` (${code})`}: ${detail}${rid ? ` rid=${rid}` : ""}`);
        this.name = "WechatApiError";
        this.code = code;
        this.rid = rid;
    }
}

function codePointLength(value) {
    return Array.from(value).length;
}

function scalar(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new InputError("frontmatter 字段必须是字符串、数字或布尔值");
}

function assertMaxChars(value, limit, label) {
    if (value && codePointLength(value) > limit) {
        throw new InputError(`${label}不能超过 ${limit} 个字符`);
    }
}

function htmlToText(html) {
    return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
        .replace(/&nbsp;/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

export function stripProductionNotes(markdown) {
    let removed = 0;
    const body = markdown.replace(PRODUCTION_NOTE_RE, () => {
        removed += 1;
        return "";
    });
    return { body: body.replace(/\n{3,}/gu, "\n\n").trim(), removed };
}

function stripDuplicateLeadingTitle(markdown, title) {
    const match = markdown.match(/^\s*#\s+([^\n]+)\r?\n/u);
    if (!match || match[1].trim() !== title.trim()) return markdown;
    return markdown.slice(match[0].length).replace(/^\s+/u, "");
}

export function parseArticle(source) {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
    if (!match) {
        throw new InputError("Markdown 顶部缺少 YAML frontmatter");
    }

    const parsed = YAML.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new InputError("frontmatter 必须是 YAML 对象");
    }

    const title = scalar(parsed.title);
    if (!title) throw new InputError("frontmatter 缺少 title");

    const author = scalar(parsed.author);
    const digest = scalar(parsed.digest);
    const sourceUrl = scalar(parsed.source_url || parsed.source);
    const cover = scalar(parsed.cover);
    assertMaxChars(title, MAX_TITLE_CHARS, "标题");
    assertMaxChars(author, MAX_AUTHOR_CHARS, "作者");
    assertMaxChars(digest, MAX_DIGEST_CHARS, "摘要");
    if (sourceUrl && Buffer.byteLength(sourceUrl, "utf8") > MAX_SOURCE_URL_BYTES) {
        throw new InputError("原文链接不能超过 1 KiB");
    }
    if (sourceUrl) {
        let parsedUrl;
        try {
            parsedUrl = new URL(sourceUrl);
        } catch {
            throw new InputError("原文链接必须是有效的 HTTP 或 HTTPS URL");
        }
        if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
            throw new InputError("原文链接必须是有效的 HTTP 或 HTTPS URL");
        }
    }

    const rawBody = source.slice(match[0].length);
    const notes = stripProductionNotes(rawBody);
    const body = stripDuplicateLeadingTitle(notes.body, title);
    if (!body.trim()) throw new InputError("正文不能为空");

    return {
        metadata: {
            title,
            author,
            digest,
            sourceUrl,
            cover,
        },
        body,
        productionNotesRemoved: notes.removed,
    };
}

export function findMarkdownImages(markdown) {
    return Array.from(markdown.matchAll(MARKDOWN_IMAGE_RE), (match) => ({
        raw: match[0],
        alt: match[1],
        source: match[2] || match[3],
        index: match.index,
    }));
}

export async function rewriteMarkdownImages(markdown, uploader) {
    const images = findMarkdownImages(markdown);
    if (images.length === 0) return markdown;

    let cursor = 0;
    let output = "";
    for (const [index, image] of images.entries()) {
        output += markdown.slice(cursor, image.index);
        const uploadedUrl = await uploader(image.source, index);
        output += `![${image.alt}](${uploadedUrl})`;
        cursor = image.index + image.raw.length;
    }
    output += markdown.slice(cursor);
    return output;
}

function applyWechatStyles(html) {
    let result = html;
    const exact = new Map([
        ["<p>", '<p style="margin:0 0 1.1em;line-height:1.9;font-size:16px;color:#2b2b2b;letter-spacing:0.02em;">'],
        ["<h1>", '<h1 style="margin:1.6em 0 0.8em;font-size:24px;line-height:1.45;color:#111;font-weight:700;">'],
        ["<h2>", '<h2 style="margin:1.8em 0 0.8em;font-size:21px;line-height:1.5;color:#111;font-weight:700;">'],
        ["<h3>", '<h3 style="margin:1.5em 0 0.7em;font-size:18px;line-height:1.5;color:#222;font-weight:700;">'],
        ["<blockquote>", '<blockquote style="margin:1.2em 0;padding:0.8em 1em;border-left:4px solid #4f78ff;background:#f5f7ff;color:#3a3a3a;">'],
        ["<ul>", '<ul style="margin:0.8em 0 1.2em;padding-left:1.4em;">'],
        ["<ol>", '<ol style="margin:0.8em 0 1.2em;padding-left:1.4em;">'],
        ["<li>", '<li style="margin:0.35em 0;line-height:1.8;font-size:16px;color:#2b2b2b;">'],
        ["<pre>", '<pre style="margin:1em 0;padding:1em;overflow-x:auto;background:#f6f8fa;border-radius:6px;line-height:1.6;">'],
        ["<code>", '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;">'],
        ["<hr />", '<hr style="margin:2em 0;border:0;border-top:1px solid #e8e8e8;">'],
        ["<hr>", '<hr style="margin:2em 0;border:0;border-top:1px solid #e8e8e8;">'],
    ]);
    for (const [from, to] of exact) result = result.replaceAll(from, to);
    result = result.replace(/<a\s+href=/gu, '<a style="color:#315efb;text-decoration:none;" href=');
    result = result.replace(/<img\s+/gu, '<img style="display:block;max-width:100%;height:auto;margin:1.2em auto;" ');
    result = result.replace(/<table>/gu, '<table style="width:100%;border-collapse:collapse;margin:1em 0;font-size:14px;">');
    result = result.replace(/<(th|td)>/gu, '<$1 style="border:1px solid #ddd;padding:0.55em;vertical-align:top;">');
    return `<section style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2b2b2b;word-break:break-word;">${result}</section>`;
}

export function renderWechatHtml(markdown) {
    const rawHtml = String(marked.parse(markdown, { gfm: true, async: false }));
    const cleanHtml = sanitizeHtml(rawHtml, {
        allowedTags: [
            "p", "br", "h1", "h2", "h3", "h4", "strong", "em", "blockquote", "ul", "ol", "li",
            "a", "img", "pre", "code", "hr", "del", "table", "thead", "tbody", "tr", "th", "td",
        ],
        allowedAttributes: {
            a: ["href", "title"],
            img: ["src", "alt", "title"],
        },
        allowedSchemes: ["http", "https"],
        allowProtocolRelative: false,
    });
    if (!cleanHtml.trim()) throw new InputError("渲染后的正文不能为空");
    const styled = applyWechatStyles(cleanHtml);
    if (styled.length >= MAX_CONTENT_CHARS) {
        throw new InputError(`渲染后的正文不能达到或超过 ${MAX_CONTENT_CHARS} 个字符`);
    }
    if (Buffer.byteLength(styled, "utf8") >= MAX_CONTENT_BYTES) {
        throw new InputError("渲染后的正文必须小于 1 MiB");
    }
    return styled;
}

function detectImage(bytes) {
    if (
        bytes.length >= 24 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a &&
        bytes.subarray(12, 16).toString("ascii") === "IHDR" &&
        bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    ) {
        return { mime: "image/png", extension: ".png" };
    }
    if (
        bytes.length >= 4 &&
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
        bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
    ) {
        return { mime: "image/jpeg", extension: ".jpg" };
    }
    throw new InputError("图片必须是有效的 JPG 或 PNG 文件");
}

export async function readLocalImage(source, baseDir, maxBytes, label) {
    if (/^https?:\/\//iu.test(source)) {
        throw new InputError(`${label}必须是本地文件；请先下载网络图片再发布`);
    }
    const resolvedPath = path.isAbsolute(source) ? path.normalize(source) : path.resolve(baseDir, source);
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat?.isFile()) throw new InputError(`${label}不存在: ${resolvedPath}`);
    if (stat.size > maxBytes) throw new InputError(`${label}文件过大: ${stat.size} bytes`);
    const bytes = await fs.readFile(resolvedPath);
    const detected = detectImage(bytes);
    return {
        bytes,
        mime: detected.mime,
        filename: `${path.basename(resolvedPath, path.extname(resolvedPath))}${detected.extension}`,
        path: resolvedPath,
    };
}

function validateMetadata(metadata) {
    if (!metadata.title) throw new InputError("缺少标题");
    assertMaxChars(metadata.title, MAX_TITLE_CHARS, "标题");
    assertMaxChars(metadata.author, MAX_AUTHOR_CHARS, "作者");
    assertMaxChars(metadata.digest, MAX_DIGEST_CHARS, "摘要");
}

export function buildDraftArticle(metadata, content, thumbMediaId) {
    validateMetadata(metadata);
    if (!thumbMediaId) throw new InputError("缺少永久封面 media_id");
    const article = {
        article_type: "news",
        title: metadata.title,
        content,
        thumb_media_id: thumbMediaId,
        need_open_comment: 0,
        only_fans_can_comment: 0,
    };
    if (metadata.author) article.author = metadata.author;
    if (metadata.digest) article.digest = metadata.digest;
    if (metadata.sourceUrl) article.content_source_url = metadata.sourceUrl;
    return article;
}

export function verifyReadback(expected, response) {
    const article = Array.isArray(response?.news_item) ? response.news_item[0] : null;
    const expectedOpening = htmlToText(expected.content).slice(0, 48);
    const actualText = htmlToText(article?.content || "");
    const checks = {
        title_match: article?.title === expected.title,
        cover_match: article?.thumb_media_id === expected.thumb_media_id,
        content_nonempty: actualText.length > 0,
        opening_match: expectedOpening.length > 0 && actualText.includes(expectedOpening),
    };
    return { ok: Object.values(checks).every(Boolean), checks };
}

function parseEnvText(source) {
    const values = {};
    for (const rawLine of source.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
        const separator = normalized.indexOf("=");
        if (separator < 1) throw new InputError("env 文件包含无法解析的行");
        const key = normalized.slice(0, separator).trim();
        let value = normalized.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) throw new InputError("env 文件包含非法变量名");
        values[key] = value;
    }
    return values;
}

async function loadEnvFile(envFile) {
    if (!envFile) return;
    const absolutePath = path.resolve(envFile);
    const values = parseEnvText(await fs.readFile(absolutePath, "utf8"));
    for (const key of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_ACCESS_TOKEN"]) {
        if (!process.env[key] && values[key]) process.env[key] = values[key];
    }
}

function credentialState() {
    return {
        app_id_set: Boolean(process.env.WECHAT_APP_ID),
        app_secret_set: Boolean(process.env.WECHAT_APP_SECRET),
        access_token_set: Boolean(process.env.WECHAT_ACCESS_TOKEN),
    };
}

async function safeFetch(url, options, action) {
    try {
        const requestOptions = { ...(options || {}) };
        if (!requestOptions.signal) requestOptions.signal = AbortSignal.timeout(30_000);
        return await fetch(url, requestOptions);
    } catch {
        throw new WechatApiError(action, { errmsg: "network request failed" });
    }
}

async function parseJsonResponse(response, action) {
    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new WechatApiError(action, { errmsg: `HTTP ${response.status}: invalid JSON response` });
    }
    if (!response.ok || (Number.isInteger(payload.errcode) && payload.errcode !== 0)) {
        throw new WechatApiError(action, payload);
    }
    return payload;
}

async function fetchAccessToken(forceRefresh = false) {
    if (!forceRefresh && cachedAccessToken) return cachedAccessToken;
    if (!forceRefresh && process.env.WECHAT_ACCESS_TOKEN) {
        cachedAccessToken = process.env.WECHAT_ACCESS_TOKEN;
        return cachedAccessToken;
    }
    const appId = process.env.WECHAT_APP_ID;
    const appSecret = process.env.WECHAT_APP_SECRET;
    if (!appId || !appSecret) {
        throw new InputError("需要 WECHAT_APP_ID 和 WECHAT_APP_SECRET，或 WECHAT_ACCESS_TOKEN");
    }
    const query = new URLSearchParams({ grant_type: "client_credential", appid: appId, secret: appSecret });
    const response = await safeFetch(`${API_BASE}/token?${query}`, undefined, "获取 access_token");
    const payload = await parseJsonResponse(response, "获取 access_token");
    if (!payload.access_token) throw new WechatApiError("获取 access_token", { errmsg: "missing access_token" });
    cachedAccessToken = payload.access_token;
    return cachedAccessToken;
}

async function requestWechatJson(method, endpoint, action, body, token, allowRefresh = true) {
    const query = new URLSearchParams({ access_token: token });
    const response = await safeFetch(`${API_BASE}${endpoint}?${query}`, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    }, action);

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new WechatApiError(action, { errmsg: `HTTP ${response.status}: invalid JSON response` });
    }
    if (allowRefresh && Number.isInteger(payload.errcode) && TOKEN_REFRESH_CODES.has(payload.errcode)) {
        const refreshed = await fetchAccessToken(true);
        return requestWechatJson(method, endpoint, action, body, refreshed, false);
    }
    if (!response.ok || (Number.isInteger(payload.errcode) && payload.errcode !== 0)) {
        throw new WechatApiError(action, payload);
    }
    return payload;
}

async function uploadImage(endpoint, action, image, token, extraQuery = {}, allowRefresh = true) {
    const query = new URLSearchParams({ access_token: token, ...extraQuery });
    const form = new FormData();
    form.append("media", new Blob([image.bytes], { type: image.mime }), image.filename);
    const response = await safeFetch(`${API_BASE}${endpoint}?${query}`, { method: "POST", body: form }, action);
    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new WechatApiError(action, { errmsg: `HTTP ${response.status}: invalid JSON response` });
    }
    if (allowRefresh && Number.isInteger(payload.errcode) && TOKEN_REFRESH_CODES.has(payload.errcode)) {
        const refreshed = await fetchAccessToken(true);
        return uploadImage(endpoint, action, image, refreshed, extraQuery, false);
    }
    if (!response.ok || (Number.isInteger(payload.errcode) && payload.errcode !== 0)) {
        throw new WechatApiError(action, payload);
    }
    return payload;
}

async function uploadCover(image, token) {
    const payload = await uploadImage("/material/add_material", "上传永久封面", image, token, { type: "image" });
    if (!payload.media_id) throw new WechatApiError("上传永久封面", { errmsg: "missing media_id" });
    return payload.media_id;
}

async function uploadInlineImage(image, token) {
    const payload = await uploadImage("/media/uploadimg", "上传正文图片", image, token);
    if (!payload.url) throw new WechatApiError("上传正文图片", { errmsg: "missing image URL" });
    return payload.url;
}

async function prepareLocalDraft(markdownPath, coverOverride) {
    const absoluteMarkdown = path.resolve(markdownPath);
    const source = await fs.readFile(absoluteMarkdown, "utf8").catch(() => null);
    if (source === null) throw new InputError(`无法读取 Markdown: ${absoluteMarkdown}`);
    const parsed = parseArticle(source);
    const baseDir = path.dirname(absoluteMarkdown);
    const coverSource = coverOverride || parsed.metadata.cover;
    if (!coverSource) throw new InputError("缺少封面；请设置 frontmatter cover 或传入 --cover");
    const cover = await readLocalImage(coverSource, baseDir, MAX_COVER_BYTES, "封面");
    const inlineRefs = findMarkdownImages(parsed.body);
    const inlineImages = [];
    for (const ref of inlineRefs) {
        inlineImages.push(await readLocalImage(ref.source, baseDir, MAX_INLINE_IMAGE_BYTES, "正文图片"));
    }
    return { ...parsed, cover, inlineImages };
}

async function dryRunDraft(options) {
    const prepared = await prepareLocalDraft(options.markdown, options.cover);
    const previewMarkdown = await rewriteMarkdownImages(
        prepared.body,
        async (_source, index) => `https://mmbiz.qpic.cn/preview-${index + 1}.jpg`,
    );
    const html = renderWechatHtml(previewMarkdown);
    return {
        ok: true,
        action: "dry_run",
        external_write: false,
        title: prepared.metadata.title,
        cover_file: prepared.cover.filename,
        inline_image_count: prepared.inlineImages.length,
        production_notes_removed: prepared.productionNotesRemoved,
        rendered_html_chars: html.length,
        rendered_html_bytes: Buffer.byteLength(html, "utf8"),
        credentials: credentialState(),
        ready_for_execute:
            Boolean(process.env.WECHAT_ACCESS_TOKEN) ||
            Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET),
    };
}

async function executeDraft(options) {
    const prepared = await prepareLocalDraft(options.markdown, options.cover);
    const previewMarkdown = await rewriteMarkdownImages(
        prepared.body,
        async (_source, index) => `https://mmbiz.qpic.cn/preview-${index + 1}.jpg`,
    );
    renderWechatHtml(previewMarkdown);

    let token = await fetchAccessToken();
    const thumbMediaId = await uploadCover(prepared.cover, token);
    token = await fetchAccessToken();
    const uploadedByPath = new Map();
    const rewritten = await rewriteMarkdownImages(prepared.body, async (_source, index) => {
        const image = prepared.inlineImages[index];
        if (!uploadedByPath.has(image.path)) {
            uploadedByPath.set(image.path, await uploadInlineImage(image, token));
            token = await fetchAccessToken();
        }
        return uploadedByPath.get(image.path);
    });
    const content = renderWechatHtml(rewritten);
    const article = buildDraftArticle(prepared.metadata, content, thumbMediaId);
    const created = await requestWechatJson("POST", "/draft/add", "创建草稿", { articles: [article] }, token);
    if (!created.media_id) throw new WechatApiError("创建草稿", { errmsg: "missing media_id" });

    token = await fetchAccessToken();
    const readback = await requestWechatJson(
        "POST",
        "/draft/get",
        "回读草稿",
        { media_id: created.media_id },
        token,
    );
    const verification = verifyReadback(article, readback);
    return {
        ok: verification.ok,
        action: "draft_created",
        external_write: true,
        media_id: created.media_id,
        title: prepared.metadata.title,
        production_notes_removed: prepared.productionNotesRemoved,
        inline_images_uploaded: uploadedByPath.size,
        readback: verification.checks,
        draft_url: readback.news_item?.[0]?.url || null,
    };
}

async function runDoctor(options) {
    const result = {
        ok: true,
        action: "doctor",
        node: process.versions.node,
        credentials: credentialState(),
        network_checked: false,
    };
    if (!options.network) return result;
    const token = await fetchAccessToken();
    const count = await requestWechatJson("GET", "/draft/count", "读取草稿数量", undefined, token);
    return { ...result, network_checked: true, draft_count: count.total_count };
}

async function getDraftSummary(options) {
    if (!options.mediaId) throw new InputError("get 命令需要 --media-id");
    const token = await fetchAccessToken();
    const response = await requestWechatJson(
        "POST",
        "/draft/get",
        "读取草稿",
        { media_id: options.mediaId },
        token,
    );
    const articles = Array.isArray(response.news_item) ? response.news_item : [];
    return {
        ok: true,
        action: "draft_get",
        media_id: options.mediaId,
        article_count: articles.length,
        articles: articles.map((article) => ({
            title: article.title || "",
            author: article.author || "",
            content_chars: typeof article.content === "string" ? article.content.length : 0,
            has_cover: Boolean(article.thumb_media_id),
            url: article.url || null,
        })),
    };
}

function parseArgs(argv) {
    const options = { command: argv[0] || "help" };
    if (options.command === "--help" || options.command === "-h") options.command = "help";
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--execute") options.execute = true;
        else if (arg === "--network") options.network = true;
        else if (arg === "--help" || arg === "-h") options.command = "help";
        else if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) throw new InputError(`参数 ${arg} 缺少值`);
            index += 1;
            if (key === "markdown") options.markdown = value;
            else if (key === "cover") options.cover = value;
            else if (key === "env-file") options.envFile = value;
            else if (key === "media-id") options.mediaId = value;
            else throw new InputError(`未知参数: ${arg}`);
        } else {
            throw new InputError(`无法识别的参数: ${arg}`);
        }
    }
    return options;
}

function helpText() {
    return `Usage:
  node scripts/wechat_draft.mjs doctor [--network] [--env-file /absolute/path/.env]
  node scripts/wechat_draft.mjs draft --markdown /absolute/path/article.md [--cover /absolute/path/cover.png] [--env-file /absolute/path/.env] [--execute]
  node scripts/wechat_draft.mjs get --media-id MEDIA_ID [--env-file /absolute/path/.env]

Safety:
  draft defaults to a local dry run. --execute uploads images and creates one external draft.
  This CLI has no formal-publish or delete command.`;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.command === "help") {
        process.stdout.write(`${helpText()}\n`);
        return;
    }
    await loadEnvFile(options.envFile);
    let result;
    if (options.command === "doctor") result = await runDoctor(options);
    else if (options.command === "draft") {
        if (!options.markdown) throw new InputError("draft 命令需要 --markdown");
        result = options.execute ? await executeDraft(options) : await dryRunDraft(options);
    } else if (options.command === "get") result = await getDraftSummary(options);
    else throw new InputError(`未知命令: ${options.command}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ok === false) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const output = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: Number.isInteger(error?.code) ? error.code : null,
            rid: typeof error?.rid === "string" ? error.rid : null,
        };
        process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
        process.exitCode = 1;
    });
}
