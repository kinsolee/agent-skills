#!/usr/bin/env node

// Last-resort OpenAI email-OTP driver. The helper response adapter below is
// intentionally limited to fields already used by the observed script contract.
// That contract has no evidenced delivery timestamp or recipient field, so it
// fails closed until a real response establishes those metadata names.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const TABLE = "tblV3Y2NDUvlbCVU";
const HELPER_ENDPOINT = "https://email.nloop.cc/api/icloud/query";
const EMAIL_CHALLENGE_PATH = "/mfa-challenge/email-otp";
const MAX_CHALLENGE_AGE_MS = 30 * 60 * 1_000;

const text = (value) => {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((item) => item && typeof item === "object" ? item.text ?? "" : item).join("");
  }
  if (typeof value === "object") return value.text ?? "";
  return String(value);
};

function senderMailbox(value) {
  if (typeof value !== "string") return null;
  const matches = value.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/giu) || [];
  if (matches.length !== 1) return null;
  return matches[0].toLowerCase();
}

export function isStrictOpenAiSender(value) {
  const mailbox = senderMailbox(value);
  if (!mailbox) return false;
  const domain = mailbox.slice(mailbox.lastIndexOf("@") + 1);
  return domain === "openai.com" || domain.endsWith(".openai.com")
    || domain === "chatgpt.com" || domain.endsWith(".chatgpt.com");
}

export function selectChallengeOtp(messages, { targetEmail, challengeStartedAtMs }) {
  const target = String(targetEmail || "").toLowerCase();
  if (!target || !Number.isFinite(challengeStartedAtMs)) {
    return { ok: false, reason: "invalid_challenge_context" };
  }

  const sorted = [...messages].sort((left, right) => {
    const leftTime = Number.isFinite(left.receivedAtMs) ? left.receivedAtMs : Number.NEGATIVE_INFINITY;
    const rightTime = Number.isFinite(right.receivedAtMs) ? right.receivedAtMs : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime;
  });
  const possibleCodes = sorted.filter((message) => (
    isStrictOpenAiSender(message.sender) && /^\d{6}$/u.test(String(message.code || ""))
  ));
  if (possibleCodes.some((message) => !Number.isFinite(message.receivedAtMs))) {
    return { ok: false, reason: "insufficient_timestamp_metadata" };
  }
  if (possibleCodes.some((message) => !message.recipientProvided)) {
    return { ok: false, reason: "insufficient_recipient_metadata" };
  }

  const eligible = possibleCodes.filter((message) => {
    if (message.receivedAtMs <= challengeStartedAtMs) return false;
    if (String(message.recipient || "").toLowerCase() !== target) return false;
    return true;
  });
  if (eligible.length !== 1) {
    return { ok: false, reason: eligible.length ? "ambiguous_challenge_codes" : "no_challenge_code" };
  }
  return { ok: true, code: String(eligible[0].code), receivedAtMs: eligible[0].receivedAtMs };
}

export function normalizeObservedHelperPayload(payload) {
  if (payload?.ok !== true || !Array.isArray(payload.mails)) return [];
  return payload.mails.map((mail) => ({
    sender: typeof mail?.from === "string" ? mail.from : null,
    code: typeof mail?.verificationCode === "string" ? mail.verificationCode : null,
    // The existing live-derived script contract uses subject/from/preview/body
    // and verificationCode only. Do not guess recipient or timestamp field names.
    recipient: null,
    recipientProvided: false,
    receivedAtMs: null,
  }));
}

export function classifyBrowserOutcome(output, childStatus) {
  if (childStatus !== 0) return "browser_process_failed";
  const match = String(output).match(/EMAIL_OTP_OUTCOME=([a-z_]+)/u);
  return match?.[1] || "missing_browser_outcome";
}

function challengeStart(value) {
  const parsed = Number(value);
  const now = Date.now();
  if (!Number.isSafeInteger(parsed) || parsed > now + 5_000 || parsed < now - MAX_CHALLENGE_AGE_MS) {
    throw new Error("challenge start must be a recent epoch-millisecond value");
  }
  return parsed;
}

function parseArguments(argv) {
  const args = [...argv];
  const recordId = args.shift();
  const spaceId = args.shift();
  const markerIndex = args.indexOf("--challenge-start-ms");
  const challengeStartedAtMs = markerIndex >= 0 ? args[markerIndex + 1] : undefined;
  if (markerIndex >= 0) args.splice(markerIndex, 2);
  if (!recordId || !spaceId || !challengeStartedAtMs || args.length) {
    throw new Error("usage: flow-email-otp.mjs <record-id> <space-id> --challenge-start-ms <epoch-ms>");
  }
  if (!Number.isSafeInteger(Number(spaceId)) || Number(spaceId) <= 0) throw new Error("space-id must be positive");
  return { recordId, spaceId: Number(spaceId), challengeStartedAtMs: challengeStart(challengeStartedAtMs) };
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid arguments");
    process.exit(2);
  }
  const { recordId, spaceId, challengeStartedAtMs } = parsed;

  const row = JSON.parse(execFileSync("lark-cli", [
    "base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
    "--record-id", recordId, "--format", "json", "--as", "user", "--field-id", "email",
  ], { encoding: "utf8" }));
  const data = row?.data || {};
  const fields = {};
  (data.fields || []).forEach((name, index) => { fields[name] = (data.data || [])[0]?.[index]; });
  const email = text(fields.email);
  if (!/@icloud\.com$/iu.test(email)) {
    console.error("email helper fallback is supported only for observed iCloud records");
    process.exit(3);
  }

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let code = null;
  let lastResult = "not_started";
  for (let round = 1; round <= 6 && !code; round += 1) {
    try {
      const response = await fetch(HELPER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        lastResult = String(payload.error || payload.detail || "").includes("未找到")
          ? `not_found_http_${response.status}`
          : `upstream_http_${response.status}`;
      } else {
        const selection = selectChallengeOtp(normalizeObservedHelperPayload(payload), {
          targetEmail: email,
          challengeStartedAtMs,
        });
        code = selection.ok ? selection.code : null;
        lastResult = selection.ok ? "found" : selection.reason;
      }
    } catch (error) {
      lastResult = error?.name === "TimeoutError" ? "timeout" : "network_error";
    }
    console.error(`email_otp_poll_round=${round} result=${lastResult}`);
    if (!code && round < 6) await sleep(8_000);
  }

  if (!code) {
    console.error(`email OTP unavailable after bounded polling; final_result=${lastResult}`);
    process.exit(4);
  }

  const script = `
const CODE = ${JSON.stringify(code)};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isChallenge = (value) => {
  try {
    const url = new URL(String(value));
    return url.hostname === 'auth.openai.com' && url.pathname === ${JSON.stringify(EMAIL_CHALLENGE_PATH)};
  } catch { return false; }
};
await useOrCreateTaskSpace(${JSON.stringify(spaceId)});
const tabs = await listTabs();
const auth = tabs.find(tab => isChallenge(tab.url));
if (!auth) {
  cliLog('EMAIL_OTP_OUTCOME=no_email_otp_tab');
} else {
  await switchTab(auth);
  const filled = await js(\`(() => {
    const input = document.querySelector('input[name="code"]');
    if (!input) return -1;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, \${JSON.stringify(CODE)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value.length;
  })()\`);
  if (filled !== 6) {
    cliLog('EMAIL_OTP_OUTCOME=no_code_input');
  } else {
    const submitted = await js(String.raw\`(() => {
      const form = document.querySelector('form');
      if (!form) return 'no_form';
      const button = form.querySelector('button[name="intent"]') || form.querySelector('button[type="submit"]') || form.querySelector('button');
      try { form.requestSubmit(button); return 'submitted'; } catch { return 'submit_error'; }
    })()\`);
    if (submitted === 'no_form') {
      cliLog('EMAIL_OTP_OUTCOME=no_form');
    } else if (submitted !== 'submitted') {
      cliLog('EMAIL_OTP_OUTCOME=submit_error');
    } else {
      let transitioned = false;
      for (let index = 0; index < 25; index += 1) {
        await sleep(1000);
        const info = await pageInfo();
        if (!isChallenge(info.url)) { transitioned = true; break; }
      }
      cliLog('EMAIL_OTP_OUTCOME=' + (transitioned ? 'transitioned' : 'still_email_otp'));
    }
  }
}
`;

  const result = spawnSync("ego-browser", ["nodejs"], {
    input: script,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const outcome = classifyBrowserOutcome(`${result.stdout || ""}\n${result.stderr || ""}`, result.status);
  if (outcome !== "transitioned") {
    console.error(`email_otp_outcome=${outcome}`);
    process.exit(5);
  }
  console.log(JSON.stringify({ outcome: "transitioned" }));
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) await main();
