#!/usr/bin/env node

// OpenCodex consent identity gate, loopback callback capture, and canonical submit.
// 2026-08-12: submit moved from the ego-browser embedded runtime to this parent
// process — the embedded runtime's process.execPath is not a usable Node binary,
// so the in-browser submit child failed silently (first live attempt, account bdca).
// The callback now travels browser→parent via cliLog and enters the canonical
// driver through stdin only; it never reaches argv or emitted output.
// Every consent/callback/submit failure invokes the canonical account-driver cancel.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flowLockPath, readAuthFile } from "./opencodex-account.mjs";

import { resolveBase } from "./feishu-base.mjs";
const { baseToken: BASE, gptAccountsTableId: TABLE } = resolveBase();
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "opencodex-account.mjs");
const [, , recordId, spaceId, authFile] = process.argv;
if (!recordId || !spaceId || !authFile || !Number.isSafeInteger(Number(spaceId)) || Number(spaceId) <= 0) {
  console.error("usage: flow-opencodex-consent.mjs <record-id> <space-id> <auth-file>");
  process.exit(2);
}

let auth;
try {
  auth = readAuthFile(authFile, { requireLock: true });
} catch {
  console.error(JSON.stringify({ outcome: "invalid_auth_file", cleanupCompleted: false }));
  process.exit(3);
}

let row;
try {
  row = JSON.parse(execFileSync("lark-cli", [
    "base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
    "--record-id", recordId, "--format", "json", "--as", "user", "--field-id", "email",
  ], { encoding: "utf8" }));
} catch {
  failClosed("identity_lookup_failed", 3);
}
const data = row?.data || {};
const fields = {};
(data.fields || []).forEach((name, index) => { fields[name] = (data.data || [])[0]?.[index]; });
const text = (value) => {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((item) => item && typeof item === "object" ? item.text ?? "" : item).join("");
  }
  if (typeof value === "object") return value.text ?? "";
  return String(value);
};
const email = text(fields.email);
if (!email) {
  failClosed("missing_target_identity", 3);
}

const mask = (value) => String(value)
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (x) => x.slice(0, 2) + '***' + x.slice(x.indexOf('@')))
  .replace(/https?:\/\/[^\s"'<>]+/g, (v) => { try { const u = new URL(v); return u.origin + u.pathname; } catch { return '<redacted-url>'; } });

const script = `
const EMAIL = ${JSON.stringify(email)};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isCandidateCallback = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      && url.pathname === '/auth/callback';
  } catch { return false; }
};
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});
let callback = null;
let consentClicked = false;
let baselineIds = new Set();
let baselineReady = false;
try {
  const baseline = await cdp('Page.getNavigationHistory');
  baselineIds = new Set(((baseline && baseline.entries) || []).map(entry => entry.id));
  baselineReady = true;
} catch {
  cliLog('OPENCODEX_CONSENT_OUTCOME=history_baseline_failed');
}
if (baselineReady) {
  const bodyText = await js(String.raw\`document.body.innerText || ''\`);
  const emails = [...new Set(String(bodyText).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])];
  if (!emails.includes(EMAIL)) {
    cliLog('OPENCODEX_CONSENT_OUTCOME=identity_mismatch');
  } else {
    const result = await js(String.raw\`(() => {
      const buttons = [...document.querySelectorAll('button')].filter(button => /Continue|继续|Allow|Authorize|授权|Accept/i.test(button.innerText || ''));
      if (!buttons.length) return 'no_consent_button';
      const button = buttons.find(candidate => candidate.type === 'submit') || buttons.at(-1);
      try { button.click(); return 'clicked'; } catch { return 'click_error'; }
    })()\`);
    consentClicked = result === 'clicked';
    if (!consentClicked) {
      cliLog('OPENCODEX_CONSENT_OUTCOME=' + result);
    } else {
      for (let index = 0; index < 25; index += 1) {
        await sleep(1000);
        let current = '';
        try { current = String((await pageInfo()).url || ''); } catch {}
        if (isCandidateCallback(current)) {
          callback = current;
          break;
        }
      }
    }
  }
}
if (!callback && consentClicked) {
  try {
    const history = await cdp('Page.getNavigationHistory');
    const hits = ((history && history.entries) || []).filter(entry => (
      !baselineIds.has(entry.id) && isCandidateCallback(entry.url)
    ));
    if (hits.length === 1) callback = hits[0].url;
    else cliLog('OPENCODEX_CONSENT_OUTCOME=history_ambiguous');
  } catch {
    cliLog('OPENCODEX_CONSENT_OUTCOME=history_failed');
  }
}
if (!callback) {
  const pageText = await js(String.raw\`document.body.innerText || ''\`);
  if (/account_deactivated/i.test(String(pageText))) {
    cliLog('OPENCODEX_CONSENT_OUTCOME=account_deactivated');
  } else if (consentClicked) {
    cliLog('OPENCODEX_CONSENT_OUTCOME=no_callback');
  }
} else {
  cliLog('OPENCODEX_CALLBACK=' + callback);
  cliLog('OPENCODEX_CONSENT_OUTCOME=callback_captured');
  callback = null;
}
`;

function localStateIsCleared() {
  try {
    return statSync(authFile).size === 0 && !existsSync(flowLockPath());
  } catch {
    return false;
  }
}

function canonicalCancel() {
  if (localStateIsCleared()) return true;
  const result = spawnSync(process.execPath, [CLI, "cancel", "--auth-file", authFile], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  return localStateIsCleared() || result.status === 0;
}

function failClosed(outcome, code, extra = null) {
  const cleanupCompleted = canonicalCancel();
  console.error(JSON.stringify({ outcome, cleanupCompleted, ...(extra ? extra : {}) }));
  process.exit(code);
}

const browser = spawnSync("ego-browser", ["nodejs"], {
  input: script,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  timeout: 180_000,
});
const combined = `${browser.stdout || ""}\n${browser.stderr || ""}`;
const browserOutcome = (combined.match(/OPENCODEX_CONSENT_OUTCOME=([a-z_]+)/gu) || []).at(-1)?.split("=")[1];
if (browser.status !== 0 || browserOutcome !== "callback_captured") {
  failClosed(browserOutcome || (browser.status === 0 ? "no_callback" : "browser_failed"), 4);
}
const callbackUrl = (combined.match(/OPENCODEX_CALLBACK=([^\n]+)/u) || [])[1] || null;
if (!callbackUrl) failClosed("callback_lost", 4);
// Submit from the real parent runtime; the callback enters the driver via stdin only.
const submit = spawnSync(process.execPath, [CLI, "submit", "--auth-file", authFile], {
  input: callbackUrl + "\n",
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
  timeout: 120_000,
});
if (submit.status !== 0) {
  failClosed("submit_failed", 4, { submitError: mask(String(submit.stderr || submit.stdout || "")).trim().slice(0, 300) || null });
}
console.log(JSON.stringify({
  outcome: "callback_accepted",
  stateBinding: auth.oauthStateHash ? "local_hash" : "server_flow_only",
}));
