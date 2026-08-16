import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    InputError,
    buildDraftArticle,
    parseArticle,
    readLocalImage,
    renderWechatHtml,
    rewriteMarkdownImages,
    verifyReadback,
} from "../scripts/wechat_draft.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(SKILL_DIR, "scripts", "wechat_draft.mjs");
const LAUNCHER_PATH = path.join(SKILL_DIR, "scripts", "wechat_draft.sh");
const ONE_PIXEL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);

test("parseArticle 读取元数据并清理重复标题和制作备注", () => {
    const parsed = parseArticle(`---
title: 人类才是 AI 工作流的核心
author: Kinso
source: https://example.com/source
cover: cover.png
---
# 人类才是 AI 工作流的核心

真正重要的不是模型，而是反馈回路。

【截图：工作流界面】→ 这里放一张截图
`);

    assert.equal(parsed.metadata.title, "人类才是 AI 工作流的核心");
    assert.equal(parsed.metadata.sourceUrl, "https://example.com/source");
    assert.equal(parsed.productionNotesRemoved, 1);
    assert.equal(parsed.body, "真正重要的不是模型，而是反馈回路。");
});

test("parseArticle 拒绝超过公众号限制的标题", () => {
    const title = "题".repeat(33);
    assert.throws(
        () => parseArticle(`---\ntitle: ${title}\n---\n正文`),
        (error) => error instanceof InputError && /32/u.test(error.message),
    );
});

test("parseArticle 拒绝非 HTTP 的原文链接", () => {
    assert.throws(
        () => parseArticle("---\ntitle: 测试标题\nsource: javascript:alert(1)\n---\n正文"),
        /HTTP 或 HTTPS/u,
    );
});

test("rewriteMarkdownImages 按顺序替换本地图片引用", async () => {
    const seen = [];
    const result = await rewriteMarkdownImages(
        "前文\n\n![图一](./a.png)\n\n![图二](./b.jpg)",
        async (source, index) => {
            seen.push([source, index]);
            return `https://mmbiz.qpic.cn/${index}.jpg`;
        },
    );

    assert.deepEqual(seen, [["./a.png", 0], ["./b.jpg", 1]]);
    assert.match(result, /https:\/\/mmbiz\.qpic\.cn\/0\.jpg/u);
    assert.match(result, /https:\/\/mmbiz\.qpic\.cn\/1\.jpg/u);
});

test("renderWechatHtml 清理危险 HTML 并添加内联样式", () => {
    const html = renderWechatHtml("## 小标题\n\n正文<script>alert('x')</script>\n\n[来源](https://example.com)");

    assert.match(html, /^<section style=/u);
    assert.match(html, /<h2 style=/u);
    assert.match(html, /href="https:\/\/example\.com"/u);
    assert.doesNotMatch(html, /<script/iu);
});

test("readLocalImage 校验本地 PNG 并拒绝网络图片", async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-draft-test-"));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(tempDir, "cover.png"), ONE_PIXEL_PNG);
    await fs.writeFile(path.join(tempDir, "truncated.png"), ONE_PIXEL_PNG.subarray(0, 8));

    const image = await readLocalImage("cover.png", tempDir, 1024, "封面");
    assert.equal(image.mime, "image/png");
    assert.equal(image.filename, "cover.png");
    await assert.rejects(
        readLocalImage("truncated.png", tempDir, 1024, "封面"),
        /有效的 JPG 或 PNG/u,
    );
    await assert.rejects(
        readLocalImage("https://example.com/cover.png", tempDir, 1024, "封面"),
        /必须是本地文件/u,
    );
});

test("buildDraftArticle 与 verifyReadback 验证关键字段", () => {
    const content = renderWechatHtml("这是用于回读验证的正文开头，后面还有一些内容。");
    const article = buildDraftArticle({
        title: "测试标题",
        author: "Kinso",
        digest: "测试摘要",
        sourceUrl: "https://example.com",
    }, content, "cover-media-id");

    const verification = verifyReadback(article, { news_item: [{ ...article }] });
    assert.equal(article.article_type, "news");
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.checks, {
        title_match: true,
        cover_match: true,
        content_nonempty: true,
        opening_match: true,
    });
});

test("CLI draft 默认只做本地 dry run", async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-draft-cli-"));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(tempDir, "cover.png"), ONE_PIXEL_PNG);
    await fs.writeFile(path.join(tempDir, "article.md"), `---
title: 本地预检测试
cover: cover.png
---
正文内容。
`);

    const result = spawnSync(process.execPath, [CLI_PATH, "draft", "--markdown", path.join(tempDir, "article.md")], {
        cwd: SKILL_DIR,
        encoding: "utf8",
        env: {
            ...process.env,
            WECHAT_APP_ID: "",
            WECHAT_APP_SECRET: "",
            WECHAT_ACCESS_TOKEN: "",
        },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.action, "dry_run");
    assert.equal(output.external_write, false);
    assert.equal(output.ready_for_execute, false);
});

test("launcher 检测代理变量并在 Node 启动前启用环境代理", async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-draft-launcher-"));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const fakeNode = path.join(tempDir, "node");
    await fs.writeFile(fakeNode, `#!/bin/sh
printf '%s\\n' "\${NODE_USE_ENV_PROXY-unset}" "$1" "$2"
`);
    await fs.chmod(fakeNode, 0o755);

    const result = spawnSync(LAUNCHER_PATH, ["--help"], {
        cwd: SKILL_DIR,
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${tempDir}:${process.env.PATH}`,
            HTTP_PROXY: "http://127.0.0.1:8234",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            NODE_USE_ENV_PROXY: "",
        },
    });

    assert.equal(result.status, 0, result.stderr);
    const [proxyFlag, scriptPath, argument] = result.stdout.trim().split("\n");
    assert.equal(proxyFlag, "1");
    assert.equal(scriptPath, CLI_PATH);
    assert.equal(argument, "--help");
});
