// sub2api-admin-api.mjs
//
// Thin wrapper around the sub2API admin REST API (Wei-Shaw/sub2api).
// Replaces the browser-UI operations that used to drive the admin panel:
//   - login / generate auth URL      -> POST /admin/openai/generate-auth-url
//   - fill callback / complete auth  -> POST /admin/openai/exchange-code + POST /admin/accounts
//   - re-authorize existing account  -> exchange-code + POST /admin/accounts/:id/apply-oauth-credentials
//   - read / verify / test / delete  -> GET/POST /admin/accounts[/:id]
//
// Auth: x-api-key header (admin API key). The key and all token-bearing
// responses are kept process-local; nothing secret is written to stdout.
//
// Provenance: endpoint inventory and request/response shapes verified against
// the upstream Go backend (internal/server/routes/admin.go,
// internal/handler/admin/{account,openai_oauth}_handler.go,
// internal/service/openai_oauth_service.go, internal/pkg/openai/oauth.go) and
// the Vue frontend (composables/useOpenAIOAuth.ts, ReAuthAccountModal.vue,
// CreateAccountModal.vue) at the repo HEAD cloned for review.
//
// Response envelope: JSON endpoints return { code, message, data }; this
// helper unwraps `data`. The test endpoint returns an SSE stream instead.

import { readEnvFile } from "./_env.mjs";

function resolveConfig() {
  const fileEnv = readEnvFile();
  const lookup = (name, fallback) => {
    if (process.env[name]) return process.env[name];
    if (fileEnv[name]) return fileEnv[name];
    return fallback;
  };
  // Accept both the legacy panel URL and a clean base; strip any /admin/accounts tail.
  // No hardcoded default: the instance address is configuration, not code.
  const raw = lookup("SUB2API_ADMIN_BASE", lookup("SUB2API_ADMIN_URL", ""));
  const adminBase = String(raw).replace(/\/admin\/accounts\/?$/, "").replace(/\/$/, "");
  if (!adminBase) {
    throw new Error("SUB2API_ADMIN_BASE (or legacy SUB2API_ADMIN_URL) is not set. Configure it in .env (gitignored) or the process environment.");
  }
  const apiKey = lookup("SUB2API_ADMIN_API_KEY", "");
  return { adminBase, apiKey };
}

function requireApiKey(apiKey) {
  if (!apiKey) {
    throw new Error("SUB2API_ADMIN_API_KEY is not set. Configure it in .env (gitignored) or the process environment.");
  }
}

class AdminApiError extends Error {
  constructor(status, url, method, detail) {
    const summary = detail ? detail.slice(0, 300) : "";
    const redacted = summary.replace(/(code|state|refresh_token|access_token|id_token)=[^&\s"]+/gi, "$1=***");
    super(`sub2api admin API ${method} ${safePath(url)} -> ${status}: ${redacted}`);
    this.status = status;
  }
}

function safePath(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[unparseable url origin]";
  }
}

function maskUrl(value) {
  if (!value) return value;
  try {
    const u = new URL(value);
    return u.origin;
  } catch {
    return "***";
  }
}

async function adminFetch(pathname, { method = "GET", body, apiKey, adminBase, sse = false } = {}) {
  requireApiKey(apiKey);
  const url = pathname.startsWith("http") ? pathname : `${adminBase}${pathname}`;
  const headers = { "x-api-key": apiKey };
  const init = { method, headers };
  if (body !== undefined && body !== null) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AdminApiError(response.status, url, method, text);
  }
  if (sse) return response; // raw Response; caller consumes the SSE stream
  const payload = await response.json();
  if (payload && typeof payload === "object" && "code" in payload) {
    if (payload.code !== 0) {
      throw new AdminApiError(response.status, url, method, JSON.stringify(payload));
    }
    return payload.data;
  }
  return payload;
}

// --- buildCredentials -----------------------------------------------------
// Mirrors the frontend useOpenAIOAuth.buildCredentials so the credentials map
// we POST matches exactly what the admin panel would send. Only non-empty
// fields are included; refresh_token is only written when a new one is present
// (prevents overwriting an existing token with an empty value).
export function buildCredentials(tokenInfo) {
  if (!tokenInfo || typeof tokenInfo !== "object") {
    throw new Error("tokenInfo must be an object");
  }
  const creds = {
    access_token: tokenInfo.access_token,
    expires_at: tokenInfo.expires_at,
  };
  if (tokenInfo.refresh_token) creds.refresh_token = tokenInfo.refresh_token;
  if (tokenInfo.id_token) creds.id_token = tokenInfo.id_token;
  if (tokenInfo.email) creds.email = tokenInfo.email;
  if (tokenInfo.chatgpt_account_id) creds.chatgpt_account_id = tokenInfo.chatgpt_account_id;
  if (tokenInfo.chatgpt_user_id) creds.chatgpt_user_id = tokenInfo.chatgpt_user_id;
  if (tokenInfo.organization_id) creds.organization_id = tokenInfo.organization_id;
  if (tokenInfo.plan_type) creds.plan_type = tokenInfo.plan_type;
  if (tokenInfo.subscription_expires_at) creds.subscription_expires_at = tokenInfo.subscription_expires_at;
  if (tokenInfo.client_id) creds.client_id = tokenInfo.client_id;
  return creds;
}

export function buildExtraInfo(tokenInfo) {
  if (!tokenInfo || typeof tokenInfo !== "object") return undefined;
  const extra = {};
  if (tokenInfo.email) extra.email = tokenInfo.email;
  if (tokenInfo.name) extra.name = tokenInfo.name;
  if (tokenInfo.privacy_mode) extra.privacy_mode = tokenInfo.privacy_mode;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

// --- high-level operations -------------------------------------------------

export async function generateAuthUrl({ proxyId, redirectUri } = {}) {
  const { adminBase, apiKey } = resolveConfig();
  const body = {};
  if (proxyId !== undefined && proxyId !== null) body.proxy_id = proxyId;
  // redirectUri omitted by default: the backend uses http://localhost:1455/auth/callback,
  // which the existing callback-capture (ego-browser CDP nav history / local :1455 server)
  // already targets. Pass redirectUri only to override.
  if (redirectUri) body.redirect_uri = redirectUri;
  const result = await adminFetch("/api/v1/admin/openai/generate-auth-url", { method: "POST", body, apiKey, adminBase });
  return { authUrl: result.auth_url, sessionId: result.session_id, redirectOrigin: maskUrl(result.auth_url) };
}

export async function exchangeCode({ sessionId, code, state, proxyId } = {}) {
  const { adminBase, apiKey } = resolveConfig();
  if (!sessionId || !code || !state) {
    throw new Error("exchangeCode requires sessionId, code, and state");
  }
  const body = { session_id: sessionId, code, state };
  if (proxyId !== undefined && proxyId !== null) body.proxy_id = proxyId;
  return adminFetch("/api/v1/admin/openai/exchange-code", { method: "POST", body, apiKey, adminBase });
}

// Create a NEW OpenAI OAuth account from exchanged tokens. Matches the
// frontend CreateAccountModal.vue create payload shape.
export async function createOAuthAccount({
  name, credentials, extra, proxyId, concurrency = 0, priority = 0,
  rateMultiplier, loadFactor, groupIds, notes, modelMapping,
} = {}) {
  const { adminBase, apiKey } = resolveConfig();
  const body = {
    name: name || "OpenAI OAuth Account",
    platform: "openai",
    type: "oauth",
    credentials,
    concurrency,
    priority,
  };
  if (extra) body.extra = extra;
  if (proxyId !== undefined && proxyId !== null) body.proxy_id = proxyId;
  if (rateMultiplier !== undefined) body.rate_multiplier = rateMultiplier;
  if (loadFactor !== undefined) body.load_factor = loadFactor;
  if (groupIds && groupIds.length) body.group_ids = groupIds;
  if (notes) body.notes = notes;
  if (modelMapping) body.credentials = { ...body.credentials, model_mapping: modelMapping };
  return adminFetch("/api/v1/admin/accounts", { method: "POST", body, apiKey, adminBase });
}

// Re-authorize an EXISTING account by applying freshly-exchanged credentials.
// Matches ReAuthAccountModal.vue: exchange-code -> buildCredentials ->
// apply-oauth-credentials. Extra is merged at the JSONB key level (never a full
// overwrite), and the account error is cleared server-side.
export async function applyOAuthCredentials({ id, credentials, extra, type = "oauth" } = {}) {
  const { adminBase, apiKey } = resolveConfig();
  if (!id) throw new Error("applyOAuthCredentials requires an account id");
  const body = { type, credentials };
  if (extra) body.extra = extra;
  return adminFetch(`/api/v1/admin/accounts/${id}/apply-oauth-credentials`, { method: "POST", body, apiKey, adminBase });
}

export async function getAccount(id) {
  const { adminBase, apiKey } = resolveConfig();
  return adminFetch(`/api/v1/admin/accounts/${id}`, { apiKey, adminBase });
}

export async function listAccounts({ search, platform = "openai", status, group, limit = 200, maxPages = 100 } = {}) {
  // The admin REST API caps the default page at 20 — without explicit pagination we silently
  // miss accounts past that boundary, including their error states (proven 2026-08-07: the
  // monitor missed #175 because it lived on page 2). Iterate every page and return a flat array.
  const { adminBase, apiKey } = resolveConfig();
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (platform) params.set("platform", platform);
    if (status) params.set("status", status);
    if (group) params.set("group", String(group));
    params.set("limit", String(limit));
    params.set("page", String(page));
    const r = await adminFetch(`/api/v1/admin/accounts${params.toString() ? `?${params}` : ""}`, { apiKey, adminBase });
    const items = Array.isArray(r) ? r : (r.items || []);
    out.push(...items);
    // Unpaginated responses arrive as a bare array — single round trip, stop.
    if (Array.isArray(r) || items.length === 0) break;
    const totalPages = Number(r.pages ?? 1);
    if (page >= totalPages) break;
  }
  return out;
}

export async function setSchedulable({ id, schedulable }) {
  const { adminBase, apiKey } = resolveConfig();
  return adminFetch(`/api/v1/admin/accounts/${id}/schedulable`, { method: "POST", body: { schedulable }, apiKey, adminBase });
}

export async function deleteAccount(id) {
  const { adminBase, apiKey } = resolveConfig();
  return adminFetch(`/api/v1/admin/accounts/${id}`, { method: "DELETE", apiKey, adminBase });
}

export async function refreshAccountToken(id) {
  const { adminBase, apiKey } = resolveConfig();
  return adminFetch(`/api/v1/admin/openai/accounts/${id}/refresh`, { method: "POST", apiKey, adminBase });
}

// Silent token refresh for an existing account using its STORED refresh_token
// (no user interaction). Upstream: POST /api/v1/admin/accounts/:id/refresh ->
// AccountHandler.Refresh -> openaiOAuthService.RefreshAccountToken ->
// RefreshTokenWithClientID + enrichTokenInfo, which re-reads plan_type and
// subscription_expires_at from the ChatGPT backend. Use as Flow C step 0:
// try this before any interactive browser re-authorization.
export async function refreshAccount(id) {
  const { adminBase, apiKey } = resolveConfig();
  if (!id) throw new Error("refreshAccount requires an account id");
  return adminFetch(`/api/v1/admin/accounts/${id}/refresh`, { method: "POST", apiKey, adminBase });
}

// Clear a persisted account error state. Upstream: POST /accounts/:id/clear-error.
// Note: /refresh and /apply-oauth-credentials do NOT always clear error state
// on their own (apply does; generic refresh success may not), so call this
// explicitly after a successful recovery.
export async function clearAccountError(id) {
  const { adminBase, apiKey } = resolveConfig();
  if (!id) throw new Error("clearAccountError requires an account id");
  return adminFetch(`/api/v1/admin/accounts/${id}/clear-error`, { method: "POST", apiKey, adminBase });
}

// Live usage probe. Upstream: GET /accounts/:id/usage?source=active&force=true.
// With force=true the backend sends a real minimal probe request to the
// upstream with this account's access token and parses rate-limit headers,
// returning UsageInfo{ five_hour, seven_day } = UsageProgress{ utilization
// (0-100+), resets_at, remaining_seconds, used_requests, limit_requests }.
// Side effect: persists codex_5h/codex_7d into extra and clears recoverable
// errors on success.
export async function getAccountUsage(id, { source = "active", force = true } = {}) {
  const { adminBase, apiKey } = resolveConfig();
  if (!id) throw new Error("getAccountUsage requires an account id");
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  if (force) params.set("force", "true");
  return adminFetch(`/api/v1/admin/accounts/${id}/usage?${params}`, { apiKey, adminBase });
}

// Test an account. The endpoint streams SSE events; we consume the stream and
// return the structured outcome, mirroring the Hard Rule 16 gate (must end with
// test_complete success=true).
export async function testAccount(id, { modelId, timeoutMs = 60000 } = {}) {
  const { adminBase, apiKey } = resolveConfig();
  const response = await adminFetch(`/api/v1/admin/accounts/${id}/test`, {
    method: "POST", body: modelId ? { model_id: modelId } : {}, apiKey, adminBase, sse: true,
  });
  return consumeTestStream(response, timeoutMs);
}

async function consumeTestStream(response, timeoutMs) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const deadline = Date.now() + timeoutMs;

  const decodeEvent = (raw) => {
    const lines = raw.split("\n");
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return null;
    try { return JSON.parse(data); } catch { return { raw: data.slice(0, 200) }; }
  };

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evt = decodeEvent(raw);
      if (!evt) continue;
      events.push(evt);
    }
  }

  const complete = events.find((e) => e.type === "test_complete" || e.event === "test_complete");
  if (complete) {
    const success = complete.success ?? complete.data?.success;
    return { ok: success === true, success, test_complete: complete, eventCount: events.length };
  }
  const errorEvent = events.find((e) => e.type === "error" || e.event === "error" || e.error);
  return {
    ok: false, success: false,
    error: errorEvent ? JSON.stringify(errorEvent).slice(0, 300) : "no test_complete event before timeout",
    eventCount: events.length,
  };
}

// --- verification summary --------------------------------------------------
// Produce a redacted verification report for Hard Rule 16 without leaking
// tokens. The caller keeps the full account object local.
export function verificationReport(account) {
  if (!account) return { ok: false, reason: "no account" };
  const cs = account.credentials_status || {};
  const creds = account.credentials || {};
  return {
    id: account.id,
    name: account.name,
    platform: account.platform,
    type: account.type,
    status: account.status,
    schedulable: account.schedulable,
    has_access_token: Boolean(cs.has_access_token ?? creds.access_token),
    has_refresh_token: Boolean(cs.has_refresh_token ?? creds.refresh_token),
    has_id_token: Boolean(cs.has_id_token ?? creds.id_token),
    error: account.error || "",
    has_model_mapping: Boolean(creds.model_mapping),
  };
}

function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") return maskEmail(value);
  if (typeof value !== "object") return value;
  const clone = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(clone)) {
    // Normalize keys: lowercase + strip underscores/dashes so camelCase (authUrl)
    // and snake_case (auth_url) match the same secret patterns.
    const nk = key.toLowerCase().replace(/[_-]/g, "");
    if (/(token|secret|password|code|state|authurl|refresh|access|apikey|cookie|url)/.test(nk)) {
      clone[key] = typeof clone[key] === "string" ? "***" : clone[key] ? "(set)" : clone[key];
    } else if (typeof clone[key] === "object") {
      clone[key] = redact(clone[key]);
    } else if (typeof clone[key] === "string") {
      clone[key] = maskEmail(clone[key]);
    }
  }
  return clone;
}

// Mask anything that looks like an email address (Hard Rule 4: no emails in output).
function maskEmail(value) {
  return String(value).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => `${m.slice(0, 2)}***@${m.split("@")[1].split(".")[0]}.***`);
}

function num(v) { return v === undefined ? undefined : Number(v); }

// --- CLI ------------------------------------------------------------------
// node sub2api-admin-api.mjs generate-auth-url --proxy-id 5
// node sub2api-admin-api.mjs exchange-code --session-id S --code C --state T
// node sub2api-admin-api.mjs create --name e@x --proxy-id 5 --group-ids 3 --concurrency 3 --session-id S --code C --state T
// node sub2api-admin-api.mjs apply --id 12 --session-id S --code C --state T
// node sub2api-admin-api.mjs get --id 12
// node sub2api-admin-api.mjs test --id 12
// node sub2api-admin-api.mjs list --search user@example.com
// node sub2api-admin-api.mjs schedulable --id 12 --on true
// node sub2api-admin-api.mjs delete --id 12
// node sub2api-admin-api.mjs verify --id 12
// node sub2api-admin-api.mjs refresh --id 12
// node sub2api-admin-api.mjs clear-error --id 12
// node sub2api-admin-api.mjs usage --id 12 [--source active] [--no-force]
// stdout prints a REDACTED JSON summary by default. Add --raw for a process-local pipe.

function parseArgs(argv) {
  const out = { _: [], raw: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--raw") { out.raw = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-./g, (m) => m[1].toUpperCase());
      out[key] = argv[++i];
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd] = args._;
  if (!cmd) {
    console.error("usage: sub2api-admin-api.mjs <command> [options] [--raw]");
    console.error("commands: generate-auth-url exchange-code create apply get list test schedulable delete verify refresh clear-error usage");
    process.exit(2);
  }

  let result;
  switch (cmd) {
    case "generate-auth-url":
      result = await generateAuthUrl({ proxyId: num(args.proxyId) });
      break;
    case "exchange-code": {
      const ti = await exchangeCode({ sessionId: args.sessionId, code: args.code, state: args.state, proxyId: num(args.proxyId) });
      result = { email: ti.email, plan_type: ti.plan_type, hasRefresh: Boolean(ti.refresh_token), hasAccess: Boolean(ti.access_token) };
      break;
    }
    case "create": {
      const ti = await exchangeCode({ sessionId: args.sessionId, code: args.code, state: args.state, proxyId: num(args.proxyId) });
      const credentials = buildCredentials(ti);
      result = await createOAuthAccount({
        name: args.name, credentials, proxyId: num(args.proxyId),
        concurrency: num(args.concurrency) || 0, priority: num(args.priority) || 0,
        groupIds: args.groupIds ? String(args.groupIds).split(",").map(Number) : undefined, notes: args.notes,
      });
      break;
    }
    case "apply": {
      const ti = await exchangeCode({ sessionId: args.sessionId, code: args.code, state: args.state, proxyId: num(args.proxyId) });
      const credentials = buildCredentials(ti);
      const extra = buildExtraInfo(ti);
      result = await applyOAuthCredentials({ id: num(args.id), credentials, extra });
      break;
    }
    case "get":
      result = await getAccount(num(args.id));
      break;
    case "list":
      result = await listAccounts({ search: args.search, platform: args.platform, limit: num(args.limit) || 200 });
      break;
    case "test":
      result = await testAccount(num(args.id), { modelId: args.modelId });
      break;
    case "schedulable":
      result = await setSchedulable({ id: num(args.id), schedulable: args.on === "false" ? false : true });
      break;
    case "delete":
      result = await deleteAccount(num(args.id));
      break;
    case "verify":
      result = verificationReport(await getAccount(num(args.id)));
      break;
    case "refresh": {
      const refreshed = await refreshAccount(num(args.id));
      result = verificationReport(refreshed && refreshed.id ? refreshed : await getAccount(num(args.id)));
      break;
    }
    case "clear-error":
      result = await clearAccountError(num(args.id));
      break;
    case "usage": {
      const usage = await getAccountUsage(num(args.id), { source: args.source || "active", force: args.noForce !== true });
      const pick = (w) => (w ? { utilization: w.utilization, resets_at: w.resets_at, used: w.used_requests, limit: w.limit_requests } : null);
      result = { five_hour: pick(usage.five_hour), seven_day: pick(usage.seven_day) };
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }

  if (args.raw) {
    process.stdout.write(JSON.stringify(result));
  } else {
    console.log(JSON.stringify(redact(result), null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message || String(err)); process.exit(1); });
}

export { readEnvFile, resolveConfig, redact, maskEmail };
export const __test__ = { buildCredentials, consumeTestStream, safePath, maskUrl, AdminApiError };
