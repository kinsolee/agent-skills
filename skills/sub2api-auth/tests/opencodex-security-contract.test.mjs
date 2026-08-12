import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FLOW_LOCK_NAME,
  FLOW_LOCK_TTL_MS,
  acquireFlowLock,
  flowLockPath,
  oauthStateHashFromAuthorizationUrl,
  parseOAuthCallback,
  releaseFlowLock,
  resolveAuthFile,
  submitCallback,
  writeProtectedAuthFile,
} from "../scripts/opencodex-account.mjs";

function callbackUrl({ host = "localhost", pathname = "/auth/callback", code = "code-placeholder", state = "state-placeholder" } = {}) {
  const url = new URL(pathname, `http://${host}`);
  if (code != null) url.searchParams.append("code", code);
  if (state != null) url.searchParams.append("state", state);
  return url;
}

test("callback parser requires exact loopback origin, path, code, and state", () => {
  const valid = callbackUrl();
  assert.equal(parseOAuthCallback(valid).stateBinding, "server_flow_only");
  assert.equal(parseOAuthCallback(callbackUrl({ host: "127.0.0.1" })).code, "code-placeholder");

  for (const invalid of [
    callbackUrl({ host: "localhost.example.com" }),
    callbackUrl({ pathname: "/auth/callback/extra" }),
    callbackUrl({ code: null }),
    callbackUrl({ state: null }),
  ]) {
    assert.throws(() => parseOAuthCallback(invalid));
  }

  const duplicateCode = callbackUrl();
  duplicateCode.searchParams.append("code", "second-placeholder");
  assert.throws(() => parseOAuthCallback(duplicateCode));

  const explicitError = callbackUrl({ code: null, state: null });
  explicitError.searchParams.set("error", "access_denied");
  assert.throws(() => parseOAuthCallback(explicitError));
});

test("callback state binds to the hash stored for the current flow", () => {
  const authorization = new URL("/authorize", "https://example.com");
  authorization.searchParams.set("state", "state-placeholder");
  const expectedStateHash = oauthStateHashFromAuthorizationUrl(authorization);
  assert.equal(parseOAuthCallback(callbackUrl(), { expectedStateHash }).stateBinding, "local_hash");
  assert.throws(() => parseOAuthCallback(callbackUrl({ state: "other-placeholder" }), { expectedStateHash }));
});

test("consent driver hands the callback to submit via stdin only", () => {
  const source = readFileSync(new URL("../scripts/flow-opencodex-consent.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /B64.*CALLBACK|CALLBACK.*B64/iu);
  // 2026-08-12: submit runs in the real parent runtime; the callback reaches it
  // through stdin only, never argv, and submission diagnostics are masked.
  assert.match(source, /input:\s*callbackUrl\s*\+/u);
  assert.match(source, /\[CLI, "submit", "--auth-file", authFile\]/u);
  assert.match(source, /OPENCODEX_CONSENT_OUTCOME=callback_captured/u);
  assert.match(source, /outcome: "callback_accepted"/u);
  assert.match(source, /submitError: mask\(/u);
});

test("callback validation failure invokes canonical cancel and clears local state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencodex-submit-test-"));
  try {
    const runtimeDir = path.join(root, "oauth-flows");
    const authFile = path.join(runtimeDir, "flow.json");
    const auth = { accountId: "account-placeholder", flowId: "flow-placeholder", oauthStateHash: null };
    writeProtectedAuthFile(authFile, JSON.stringify(auth), { runtimeDir });
    acquireFlowLock(authFile, { runtimeDir, now: 10_000, pid: 101 });
    const routes = [];
    await assert.rejects(() => submitCallback({
      authFile,
      auth,
      input: "invalid-placeholder",
      runtimeDir,
      request: async (method, route) => {
        routes.push([method, route]);
        return { ok: true, cancelled: true };
      },
    }), /cancelled/u);
    assert.deepEqual(routes, [["POST", "/api/codex-auth/login/cancel"]]);
    assert.equal(readFileSync(authFile, "utf8"), "");
    assert.throws(() => statSync(flowLockPath(runtimeDir)), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callback submit failure invokes canonical cancel and clears local state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencodex-submit-test-"));
  try {
    const runtimeDir = path.join(root, "oauth-flows");
    const authFile = path.join(runtimeDir, "flow.json");
    const auth = { accountId: "account-placeholder", flowId: "flow-placeholder", oauthStateHash: null };
    writeProtectedAuthFile(authFile, JSON.stringify(auth), { runtimeDir });
    acquireFlowLock(authFile, { runtimeDir, now: 10_000, pid: 101 });
    const routes = [];
    await assert.rejects(() => submitCallback({
      authFile,
      auth,
      input: callbackUrl().toString(),
      runtimeDir,
      request: async (method, route) => {
        routes.push([method, route]);
        if (route.endsWith("/code")) throw new Error("synthetic submit rejection");
        return { ok: true, cancelled: true };
      },
    }), /cancelled/u);
    assert.deepEqual(routes, [
      ["POST", "/api/codex-auth/login/code"],
      ["POST", "/api/codex-auth/login/cancel"],
    ]);
    assert.equal(readFileSync(authFile, "utf8"), "");
    assert.throws(() => statSync(flowLockPath(runtimeDir)), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixed lock is private and never follows the auth-file directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencodex-lock-test-"));
  try {
    const runtimeDir = path.join(root, "oauth-flows");
    const authFile = path.join(runtimeDir, "flow-a.json");
    writeProtectedAuthFile(authFile, "", { runtimeDir });
    const result = acquireFlowLock(authFile, { runtimeDir, now: 10_000, pid: 101 });
    assert.equal(result.lockPath, path.join(runtimeDir, FLOW_LOCK_NAME));
    assert.equal(flowLockPath(runtimeDir), result.lockPath);
    assert.equal(statSync(runtimeDir).mode & 0o777, 0o700);
    assert.equal(statSync(result.lockPath).mode & 0o777, 0o600);
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
    assert.throws(() => resolveAuthFile(path.join(root, "outside.json"), runtimeDir));
    releaseFlowLock(authFile, { runtimeDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale recovery requires both a dead PID and an expired TTL", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencodex-stale-test-"));
  try {
    const runtimeDir = path.join(root, "oauth-flows");
    const firstAuth = path.join(runtimeDir, "flow-a.json");
    const secondAuth = path.join(runtimeDir, "flow-b.json");
    writeProtectedAuthFile(firstAuth, "protected-placeholder", { runtimeDir });
    writeProtectedAuthFile(secondAuth, "", { runtimeDir });
    acquireFlowLock(firstAuth, { runtimeDir, now: 1_000_000, pid: 111 });

    assert.throws(() => acquireFlowLock(secondAuth, {
      runtimeDir,
      now: 1_000_000 + FLOW_LOCK_TTL_MS + 1,
      pid: 222,
      pidIsAlive: () => true,
    }), /active/u);
    assert.notEqual(readFileSync(firstAuth, "utf8"), "");

    assert.throws(() => acquireFlowLock(secondAuth, {
      runtimeDir,
      now: 1_000_000 + FLOW_LOCK_TTL_MS,
      pid: 222,
      pidIsAlive: () => false,
    }), /recent/u);

    const recovered = acquireFlowLock(secondAuth, {
      runtimeDir,
      now: 1_000_000 + FLOW_LOCK_TTL_MS + 1,
      pid: 222,
      pidIsAlive: () => false,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(readFileSync(firstAuth, "utf8"), "");
    const owner = JSON.parse(readFileSync(flowLockPath(runtimeDir), "utf8"));
    assert.equal(owner.authFile, secondAuth);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
