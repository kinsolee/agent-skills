#!/usr/bin/env node

// OpenCodex account-pool driver. OAuth material lives only in a protected,
// repository-external runtime directory. The fixed lock serializes flows across
// shell and agent sessions; callback input is accepted through stdin only.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
export const FLOW_LOCK_NAME = ".opencodex-reauth.lock";
export const FLOW_LOCK_TTL_MS = 30 * 60 * 1_000;

export function defaultRuntimeDirectory(home = homedir()) {
  return path.join(home, ".opencodex", "oauth-flows");
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new Error("Unable to read required local configuration");
  }
}

function parseEnvFile(file) {
  const values = {};
  for (const rawLine of readText(file).split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^export\s+/u, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function activeOpenCodexBaseUrl() {
  const config = readText(path.join(homedir(), ".codex", "config.toml"));
  let inProvider = false;
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inProvider = line.slice(1, -1) === "model_providers.opencodex";
      continue;
    }
    if (!inProvider) continue;
    const match = line.match(/^base_url\s*=\s*["']([^"']+)["']/u);
    if (match) return match[1];
  }
  return null;
}

function managementOrigin(projectEnv) {
  const configured = activeOpenCodexBaseUrl() || process.env.OCX_ADMIN_BASE || projectEnv.OCX_ADMIN_BASE;
  if (!configured) throw new Error("OpenCodex base URL is unavailable");
  const url = new URL(configured);
  url.pathname = url.pathname.replace(/\/v1\/?$/u, "").replace(/\/$/u, "");
  url.search = "";
  url.hash = "";
  if (url.protocol !== "https:") throw new Error("The OpenCodex account driver requires HTTPS");
  return url;
}

function required(name, ...sources) {
  const value = process.env[name] || sources.map((source) => source[name]).find(Boolean);
  if (!value) throw new Error(`Required environment variable is unavailable: ${name}`);
  return value;
}

function ensureProtectedDirectory(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(runtimeDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("OpenCodex runtime path is not a real directory");
  chmodSync(runtimeDir, 0o700);
  if ((lstatSync(runtimeDir).mode & 0o077) !== 0) throw new Error("OpenCodex runtime directory is not private");
}

export function resolveAuthFile(authFile, runtimeDir = defaultRuntimeDirectory()) {
  const resolvedRuntime = path.resolve(runtimeDir);
  const resolved = path.resolve(String(authFile || ""));
  if (!authFile || path.dirname(resolved) !== resolvedRuntime || path.basename(resolved) === FLOW_LOCK_NAME) {
    throw new Error("Auth file must be a direct child of the protected OpenCodex runtime directory");
  }
  if (resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error("Auth file must remain outside the repository");
  }
  return resolved;
}

function assertSafeRegularFile(file, expectedMode = 0o600) {
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (!stats) return false;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Protected runtime file is not a regular file");
  if ((stats.mode & 0o777) !== expectedMode) throw new Error("Protected runtime file has unsafe permissions");
  return true;
}

function writeProtectedFile(file, contents) {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
}

export function writeProtectedAuthFile(authFile, contents, { runtimeDir = defaultRuntimeDirectory() } = {}) {
  ensureProtectedDirectory(runtimeDir);
  const resolved = resolveAuthFile(authFile, runtimeDir);
  assertSafeRegularFile(resolved);
  writeProtectedFile(resolved, contents);
  if (!assertSafeRegularFile(resolved)) throw new Error("Unable to persist protected auth file");
  return resolved;
}

export function readAuthFile(authFile, {
  runtimeDir = defaultRuntimeDirectory(),
  requireLock = false,
} = {}) {
  ensureProtectedDirectory(runtimeDir);
  const resolved = resolveAuthFile(authFile, runtimeDir);
  if (!assertSafeRegularFile(resolved)) throw new Error("Auth file is unavailable");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new Error("Auth file is empty or invalid");
  }
  if (typeof parsed.flowId !== "string" || !parsed.flowId || typeof parsed.accountId !== "string" || !parsed.accountId) {
    throw new Error("Auth file is missing required flow metadata");
  }
  if (parsed.oauthStateHash != null && !/^[a-f0-9]{64}$/u.test(parsed.oauthStateHash)) {
    throw new Error("Auth file has invalid state-binding metadata");
  }
  if (requireLock) assertFlowLockOwned(resolved, { runtimeDir });
  return { ...parsed, authFile: resolved };
}

export function flowLockPath(runtimeDir = defaultRuntimeDirectory()) {
  return path.join(path.resolve(runtimeDir), FLOW_LOCK_NAME);
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function parseLock(lockPath, runtimeDir) {
  if (!assertSafeRegularFile(lockPath)) throw new Error("Flow lock is unavailable");
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    throw new Error("Flow lock metadata is invalid");
  }
  const authFile = resolveAuthFile(owner.authFile, runtimeDir);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isSafeInteger(owner.acquiredAt)) {
    throw new Error("Flow lock metadata is invalid");
  }
  return { authFile, pid: owner.pid, acquiredAt: owner.acquiredAt };
}

export function assertFlowLockOwned(authFile, { runtimeDir = defaultRuntimeDirectory() } = {}) {
  const resolvedAuthFile = resolveAuthFile(authFile, runtimeDir);
  const owner = parseLock(flowLockPath(runtimeDir), runtimeDir);
  if (owner.authFile !== resolvedAuthFile) throw new Error("Flow lock belongs to another auth file");
  return owner;
}

function createFlowLock(lockPath, owner) {
  writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(lockPath, 0o600);
  assertSafeRegularFile(lockPath);
}

export function acquireFlowLock(authFile, {
  runtimeDir = defaultRuntimeDirectory(),
  now = Date.now(),
  pid = process.pid,
  ttlMs = FLOW_LOCK_TTL_MS,
  pidIsAlive = isProcessAlive,
} = {}) {
  ensureProtectedDirectory(runtimeDir);
  const resolvedAuthFile = resolveAuthFile(authFile, runtimeDir);
  const lockPath = flowLockPath(runtimeDir);
  const owner = { authFile: resolvedAuthFile, pid, acquiredAt: now };
  try {
    createFlowLock(lockPath, owner);
    return { lockPath, recovered: false };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = parseLock(lockPath, runtimeDir);
  const age = now - existing.acquiredAt;
  if (age < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000) {
    throw new Error("Existing OpenCodex flow lock has unreasonable timing metadata");
  }
  if (pidIsAlive(existing.pid)) throw new Error("Another OpenCodex reauthorization flow is active");
  if (age <= ttlMs) throw new Error("A recent OpenCodex reauthorization flow may still be active");

  // Recovery requires both a dead owner and an expired TTL. Clear the matching
  // stale auth material before replacing the fixed lock; malformed/live locks
  // remain untouched and therefore fail closed.
  writeProtectedAuthFile(existing.authFile, "", { runtimeDir });
  unlinkSync(lockPath);
  try {
    createFlowLock(lockPath, owner);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another OpenCodex reauthorization flow won lock recovery");
    throw error;
  }
  return { lockPath, recovered: true };
}

export function releaseFlowLock(authFile, { runtimeDir = defaultRuntimeDirectory() } = {}) {
  const resolvedAuthFile = resolveAuthFile(authFile, runtimeDir);
  const lockPath = flowLockPath(runtimeDir);
  const stats = lstatSync(lockPath, { throwIfNoEntry: false });
  if (!stats) return;
  const owner = parseLock(lockPath, runtimeDir);
  if (owner.authFile !== resolvedAuthFile) throw new Error("Flow lock belongs to another auth file");
  unlinkSync(lockPath);
}

export function sanitizeAuthFile(authFile, {
  runtimeDir = defaultRuntimeDirectory(),
  releaseLock = true,
} = {}) {
  const resolved = writeProtectedAuthFile(authFile, "", { runtimeDir });
  if (releaseLock) releaseFlowLock(resolved, { runtimeDir });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function oauthStateHashFromAuthorizationUrl(value) {
  try {
    const values = new URL(value).searchParams.getAll("state");
    if (values.length !== 1 || !values[0]) return null;
    return sha256(values[0]);
  } catch {
    return null;
  }
}

export function parseOAuthCallback(input, { expectedStateHash = null } = {}) {
  let url;
  try {
    url = new URL(String(input || ""));
  } catch {
    throw new Error("Callback input is not a URL");
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.pathname !== "/auth/callback" || url.username || url.password || url.hash) {
    throw new Error("Callback origin or path is invalid");
  }
  if (url.searchParams.has("error") || url.searchParams.has("error_description")) {
    throw new Error("OAuth provider returned an explicit error callback");
  }
  const codes = url.searchParams.getAll("code");
  const states = url.searchParams.getAll("state");
  if (codes.length !== 1 || states.length !== 1 || !codes[0] || !states[0]
      || codes[0].length > 2048 || states[0].length > 2048) {
    throw new Error("Callback must contain one non-empty code and state");
  }
  if (expectedStateHash) {
    const expected = Buffer.from(expectedStateHash, "hex");
    const actual = Buffer.from(sha256(states[0]), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Callback state does not match the current auth flow");
    }
  }
  return {
    code: codes[0],
    state: states[0],
    stateBinding: expectedStateHash ? "local_hash" : "server_flow_only",
  };
}

const HEALTH_STATUSES = new Set(["healthy", "cooldown", "reauth_required", "warning"]);
const HEALTH_REASONS = new Set([
  "rate_limit", "quota", "unauthorized", "forbidden", "refresh_failed",
  "refresh_conflict", "metadata_mismatch", "stale_credentials",
]);

function enumValue(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function accountSummary(account) {
  const quota = account.quota && typeof account.quota === "object" ? {
    weeklyPercent: account.quota.weeklyPercent ?? null,
    monthlyPercent: account.quota.monthlyPercent ?? null,
    weeklyResetAt: account.quota.weeklyResetAt ?? null,
    monthlyResetAt: account.quota.monthlyResetAt ?? null,
    updatedAt: account.quota.updatedAt ?? null,
  } : null;
  const health = account.health && typeof account.health === "object" ? {
    status: enumValue(account.health.status, HEALTH_STATUSES),
    reason: enumValue(account.health.reason, HEALTH_REASONS),
    until: finiteNumber(account.health.until),
  } : null;
  return {
    id: account.id ?? null,
    identityRedacted: true,
    plan: typeof account.plan === "string" && /^[a-z0-9_-]{1,32}$/iu.test(account.plan) ? account.plan : null,
    isMain: Boolean(account.isMain),
    paused: Boolean(account.paused),
    priority: account.priority ?? 0,
    hasCredential: Boolean(account.hasCredential),
    needsReauth: Boolean(account.needsReauth),
    health,
    quotaProbeSkipped: Boolean(account.quotaProbeSkipped),
    quota,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8").trim();
}

export async function canonicalCancel(authFile, auth, request, {
  runtimeDir = defaultRuntimeDirectory(),
} = {}) {
  let cancellationError = null;
  let payload = null;
  try {
    payload = await request("POST", "/api/codex-auth/login/cancel", { flowId: auth.flowId });
    if (payload.ok !== true) throw new Error("Cancellation was rejected");
  } catch (error) {
    cancellationError = error;
  } finally {
    sanitizeAuthFile(authFile, { runtimeDir });
  }
  if (cancellationError) throw new Error("Flow cancellation failed; local flow state was cleared");
  return payload;
}

export async function submitCallback({
  authFile,
  auth,
  input,
  request,
  runtimeDir = defaultRuntimeDirectory(),
}) {
  let callback;
  try {
    if (!input || input.length > 4096) throw new Error("Callback input is missing or too long");
    callback = parseOAuthCallback(input, { expectedStateHash: auth.oauthStateHash ?? null });
    const payload = await request("POST", "/api/codex-auth/login/code", { flowId: auth.flowId, input });
    if (payload.ok !== true) throw new Error("Callback submission was rejected");
  } catch {
    try {
      await canonicalCancel(authFile, auth, request, { runtimeDir });
    } catch {
      throw new Error("Callback submission failed; cancellation was attempted and local flow state was cleared");
    }
    throw new Error("Callback submission failed; flow was cancelled");
  }
  return callback;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const knownCommands = new Set(["check", "start", "status", "submit", "cancel", "delete"]);
  if (!knownCommands.has(command)) fail("usage: opencodex-account.mjs <check|start|status|submit|cancel|delete> ...", 2);

  const option = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length) return undefined;
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };
  const flag = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
  };

  const projectEnv = parseEnvFile(path.join(repoRoot, ".env"));
  const codexEnv = parseEnvFile(path.join(homedir(), ".codex", "secrets", "opencodex-provider.env"));
  const origin = managementOrigin(projectEnv);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "CF-Access-Client-Id": required("CF_ACCESS_CLIENT_ID", codexEnv),
    "CF-Access-Client-Secret": required("CF_ACCESS_CLIENT_SECRET", codexEnv),
    "x-opencodex-api-key": required("OCX_ADMIN_AUTH_TOKEN", projectEnv),
  };
  const request = async (method, route, body, timeoutMs = 60_000) => {
    const url = new URL(route, `${origin.origin}${origin.pathname || "/"}`);
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseText = await response.text();
    if (response.status !== 200 && response.status !== 202) {
      const digest = createHash("sha256").update(responseText).digest("hex");
      throw new Error(`OpenCodex management request returned HTTP ${response.status}; response_sha256=${digest}`);
    }
    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error(`OpenCodex management request returned HTTP ${response.status} with invalid JSON`);
    }
  };

  if (command === "check") {
    const refresh = flag("--refresh");
    if (args.length) fail("usage: opencodex-account.mjs check [--refresh]", 2);
    const payload = await request("GET", `/api/codex-auth/accounts${refresh ? "?refresh=1" : ""}`);
    if (!Array.isArray(payload.accounts)) throw new Error("OpenCodex accounts payload is missing an accounts array");
    const accounts = payload.accounts.map(accountSummary);
    console.log(JSON.stringify({
      accountCount: accounts.length,
      reauthCount: accounts.filter((account) => account.needsReauth || account.health?.status === "reauth_required").length,
      skippedProbeCount: accounts.filter((account) => account.quotaProbeSkipped).length,
      accounts,
    }, null, 2));
    return;
  }

 if (command === "start") {
   const accountId = option("--id");
    const addMode = flag("--add");
   const authFile = option("--auth-file");
    if (!authFile || args.length) fail("usage: opencodex-account.mjs start --add --auth-file <path>  |  start --id <account-id> --auth-file <path>", 2);
    if (addMode && accountId) fail("--add cannot be combined with --id", 2);
    if (!addMode && !accountId) fail("reauth requires --id; use --add to start a new-account flow", 2);
   acquireFlowLock(authFile);
   try {
     writeProtectedAuthFile(authFile, "");
      // 2026-08-13: --add starts a new-account flow. Omitting id/reauth calls the same
      // /api/codex-auth/login route the dashboard "Add account" button uses; the server assigns
      // chatgpt-<ts> and persists the credential on completion. The placeholder accountId only
      // satisfies readAuthFile's non-empty check; submit and login-status key off flowId, and the
      // real pool id returns in the login-status response (see status command).
      const loginBody = addMode ? {} : { id: accountId, reauth: true };
      const payload = await request("POST", "/api/codex-auth/login", loginBody);
     if (typeof payload.flowId !== "string" || !payload.flowId || typeof payload.url !== "string" || !payload.url) {
       throw new Error("OpenCodex login start did not return required flow metadata");
     }
     const oauthStateHash = oauthStateHashFromAuthorizationUrl(payload.url);
      const fileAccountId = addMode ? "__add_pending__" : accountId;
     writeProtectedAuthFile(authFile, `${JSON.stringify({
        accountId: fileAccountId,
       flowId: payload.flowId,
       authUrl: payload.url,
       oauthStateHash,
     })}\n`);
     console.log(JSON.stringify({
        outcome: addMode ? "started_add" : "started",
       stateBinding: oauthStateHash ? "local_hash" : "server_flow_only",
        hasInstructions: Boolean(payload.instructions),
      }));
    } catch (error) {
      try {
        sanitizeAuthFile(authFile);
      } catch {
        // If an unsafe pre-existing auth path prevented sanitization, do not
        // touch that path; release only the matching fixed lock.
        releaseFlowLock(authFile);
      }
      throw error;
    }
    return;
  }

  if (command === "status") {
    const authFile = option("--auth-file");
    if (!authFile || args.length) fail("usage: opencodex-account.mjs status --auth-file <path>", 2);
    const auth = readAuthFile(authFile, { requireLock: true });
    const query = new URLSearchParams({ flowId: auth.flowId, accountId: auth.accountId, reauth: "1" });
    const payload = await request("GET", `/api/codex-auth/login-status?${query}`);
    const errorClass = typeof payload.error === "string" && /account_deactivated/iu.test(payload.error)
      ? "account_deactivated"
      : payload.error ? "oauth_error" : null;
    console.log(JSON.stringify({
      status: payload.status ?? null,
      accountId: payload.accountId ?? auth.accountId,
      identityRedacted: true,
      hasError: Boolean(payload.error),
      errorClass,
      terminalAccountState: errorClass === "account_deactivated",
    }));
    if (["done", "error", "expired"].includes(payload.status)) sanitizeAuthFile(authFile);
    if (payload.status === "error" || payload.status === "expired") process.exitCode = 3;
    return;
  }

  if (command === "submit") {
    const authFile = option("--auth-file");
    if (!authFile || args.length) fail("usage: <callback-input> | opencodex-account.mjs submit --auth-file <path>", 2);
    const auth = readAuthFile(authFile, { requireLock: true });
    const input = await readStdin();
    const callback = await submitCallback({ authFile, auth, input, request });
    console.log(JSON.stringify({ outcome: "callback_accepted", stateBinding: callback.stateBinding }));
    return;
  }

  if (command === "delete") {
    // 2026-08-13: delete a pool account row (terminal accounts, e.g. account_deactivated).
    // Destructive — caller-authorized. DELETE /api/codex-auth/accounts?id=<id>; 200/202/204 = removed.
    const accountId = option("--id");
    if (!accountId || args.length) fail("usage: opencodex-account.mjs delete --id <account-id>", 2);
    const delUrl = new URL(`/api/codex-auth/accounts`, `${origin.origin}${origin.pathname || "/"}`);
    delUrl.searchParams.set("id", accountId);
    const response = await fetch(delUrl, { method: "DELETE", redirect: "manual", headers, signal: AbortSignal.timeout(60_000) });
    const responseText = await response.text();
    if (response.status !== 200 && response.status !== 202 && response.status !== 204) {
      const digest = createHash("sha256").update(responseText).digest("hex");
      throw new Error(`delete returned HTTP ${response.status}; response_sha256=${digest}`);
    }
    console.log(JSON.stringify({ outcome: "deleted", id: accountId, http: response.status }));
    return;
  }

  const authFile = option("--auth-file");
  if (!authFile || args.length) fail("usage: opencodex-account.mjs cancel --auth-file <path>", 2);
  const auth = readAuthFile(authFile);
  const payload = await canonicalCancel(authFile, auth, request);
  console.log(JSON.stringify({ outcome: "cancelled", remoteCancelled: Boolean(payload.cancelled) }));
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : "OpenCodex account operation failed");
  }
}
