// flow-email-login.mjs — OpenAI passwordless email-code login driver (ichzl long-poll helper).
// For accounts that authenticate by email verification code (no stored password).
// Live-verified 2026-08-13 (OpenCodex reauth, a passwordless @icloud.com pool account):
//   typeText email → /email-verification → in-browser ichzl fetch loop → typeText code → outcome.
// Lesson 1: email and code inputs MUST use typeText (real keystrokes); the native value setter
//   sets DOM value but leaves React controlled-component state empty, so requestSubmit no-ops.
// Lesson 2: ichzl GET /v1/code/<token> returns 404 until a code email lands in the monitored
//   inbox, then HTTP 200 {ok,email,code,receivedAt,subject,...}. The auto-send on /email-verification
//   page load IS indexed (fresh code arrives within a few seconds). ichzl caches the latest code, so
//   capture a pre-send baseline and accept a code only if it differs from baseline AND its receivedAt
//   is at/after the code-page load time.
// Lesson 3 (CRITICAL): do NOT click 重新发送电子邮件 — on these accounts it crashes the page to
//   HTTP 500 / chrome-error IMMEDIATELY (input gone, url=null). The whole email→code→submit path
//   MUST run inside ONE ego-browser call (poll ichzl via the runtime's own fetch — the ichzl cert is
//   valid for the host, no TLS bypass needed) and submit the code the moment it arrives.
// Lesson 4: a markdown-link Base cell reads back as [label](url); take the URL inside the parens.
// Lesson 5: account_deactivated surfaces on the SAME /email-verification url right after a correct
//   code is accepted (body contains account_deactivated / 账户已被删除或停用). It is terminal — do
//   not retry; the email-code path itself succeeded (it authenticated far enough to reveal it).
// Usage: node flow-email-login.mjs <gpt_record_id> <space_id_or_name> <auth_file>
//   <space_id_or_name>: numeric id = reuse an existing task space; non-numeric = create by name.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const TABLE = "tblV3Y2NDUvlbCVU";
const [, , rec, spaceId, authFile] = process.argv;
if (!rec || !spaceId || !authFile) {
  console.error("usage: flow-email-login.mjs <record_id> <space_id_or_name> <auth_file>");
  process.exit(2);
}

// --- read email + email_helper_url from Base (process-local); strip markdown-link wrapper ---
const j = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
  "--record-id", rec, "--format", "json", "--as", "user", "--field-id", "email", "--field-id", "email_helper_url"], { encoding: "utf8" }));
const d = j?.data || {};
const f = {};
(d.fields || []).forEach((n, i) => { f[n] = (d.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const EMAIL = txt(f.email);
let CODE_URL = txt(f.email_helper_url);
{ const m = CODE_URL.match(/\((https?:\/\/[^)]+)\)/); if (m) CODE_URL = m[1]; else { const m2 = CODE_URL.match(/https?:\/\/[^\s)]+/); if (m2) CODE_URL = m2[0]; } }
const AUTH_URL = JSON.parse(readFileSync(authFile, "utf8")).authUrl;
if (!EMAIL || !CODE_URL || !AUTH_URL) { console.error("missing inputs (email/email_helper_url/authUrl)"); process.exit(3); }

const SPACE_REF = /^\d+$/.test(String(spaceId)) ? Number(spaceId) : String(spaceId);

// Single ego-browser call: email → code page → resend → in-browser ichzl poll → submit → transition.
const script = `
const EMAIL = ${JSON.stringify(EMAIL)};
const CODE_URL = ${JSON.stringify(CODE_URL)};
const AUTH_URL = ${JSON.stringify(AUTH_URL)};
const SPACE_REF = ${JSON.stringify(SPACE_REF)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskUrl = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u); } };
const sixDig = (s) => /^\\d{6}$/.test(String(s));

await useOrCreateTaskSpace(SPACE_REF);

// Lesson 2/3: capture any stale cached code BEFORE triggering a fresh send, so we wait for a new one.
let baseline = null;
try { const r = await fetch(CODE_URL); if (r.ok) { const j = await r.json(); if (sixDig(j.code)) baseline = String(j.code); } } catch (e) {}
cliLog('baseline=' + (baseline ? '<stale6>' : 'none'));

await openOrReuseTab(AUTH_URL, { wait: true });
await sleep(4500);
let info = await pageInfo();
cliLog('INIT url=' + maskUrl(info.url) + ' title=' + info.title);

// email: focus, clear via native setter, typeText (Lesson 1)
await js(String.raw\`(() => { const e = document.querySelector('input[name="email"]'); if (e) { e.focus(); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(e, ''); e.dispatchEvent(new Event('input', { bubbles: true })); } })()\`);
await sleep(250);
await typeText(EMAIL);
await sleep(500);
const ev = await js(String.raw\`(() => { const e = document.querySelector('input[name="email"]'); return e ? e.value.length : -1; })()\`);
cliLog('email_typed=' + ev + '/' + EMAIL.length);
const esub = await js(String.raw\`(() => { const form = document.querySelector('form'); if (!form) return 'no_form'; const btn = [...form.querySelectorAll('button')].find((x) => /继续|Continue|Next/.test(x.innerText || '')) || document.querySelector('button[name="intent"]') || form.querySelector('button[type="submit"]'); try { form.requestSubmit(btn); return 'submitted'; } catch (e) { return 'err:' + e.message; } })()\`);
cliLog('email_submit=' + esub);

// wait for /email-verification + code input (up to 25s)
let codeReady = false;
let codePageAt = 0;
for (let i = 0; i < 25; i++) {
  await sleep(1000);
  const ni = await pageInfo();
  const hasCode = await js(String.raw\`(() => !!document.querySelector('input[name="code"]'))()\`);
  if ((ni.url || '').includes('/email-verification') && hasCode) { cliLog('CODE_PAGE after ' + (i + 1) + 's'); codeReady = true; codePageAt = Date.now(); break; }
  if (i === 24) cliLog('NO_CODE_PAGE url=' + maskUrl(ni.url));
}
if (!codeReady) { cliLog('ABORT_no_code_page'); }

if (codeReady) {
  // Lesson (2026-08-13): do NOT click 重新发送电子邮件 — it crashes this page to HTTP 500
  // immediately (chrome-error, input gone). The auto-send on page load IS indexed by ichzl;
  // just poll for the fresh code. Accept a code only if it differs from the pre-send baseline
  // AND its receivedAt is at/after the code-page load (defends against ichzl's stale cache).
  let CODE = null;
  for (let i = 0; i < 36; i++) {
    try {
      const r = await fetch(CODE_URL);
      if (r.ok) {
        const pj = await r.json();
        const c = pj && sixDig(pj.code) ? String(pj.code) : null;
        const rec = pj && pj.receivedAt ? Date.parse(pj.receivedAt) : NaN;
        const freshByTime = !isNaN(rec) ? rec >= (codePageAt - 15000) : true;
        if (c && c !== baseline && freshByTime) { CODE = c; cliLog('code_fresh after ~' + (i * 3) + 's'); break; }
      }
    } catch (e) {}
    await sleep(3000);
  }
  if (!CODE) { cliLog('ABORT_no_fresh_code'); }
  else {
    // submit the code immediately (keep the window on the code page short)
    await js(String.raw\`(() => { const c = document.querySelector('input[name="code"]'); if (c) { c.focus(); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(c, ''); c.dispatchEvent(new Event('input', { bubbles: true })); } })()\`);
    await sleep(250);
    await typeText(CODE);
    await sleep(500);
    const cl = await js(String.raw\`(() => { const c = document.querySelector('input[name="code"]'); return c ? c.value.length : -1; })()\`);
    cliLog('code_typed=' + cl + '/6');
    const csub = await js(String.raw\`(() => { const form = document.querySelector('form'); if (!form) return 'no_form'; const btn = [...form.querySelectorAll('button')].find((x) => /继续|Continue|Next/.test(x.innerText || '')) || form.querySelector('button[type="submit"]'); try { form.requestSubmit(btn); return 'submitted'; } catch (e) { return 'err:' + e.message; } })()\`);
    cliLog('code_submit=' + csub);
    const startUrl = (await pageInfo()).url || '';
    let resolved = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const ni = await pageInfo();
      const u = ni.url || '';
      const body = await js(String.raw\`(() => document.body.innerText || '')()\`);
      // account_deactivated can surface on the SAME url right after a correct code (proven 2026-08-13).
      if (/account_deactivated|账户已被删除|停用|deactivated/i.test(body)) { cliLog('OUTCOME=account_deactivated url=' + maskUrl(u)); resolved = true; break; }
      const moved = u.split('?')[0] !== startUrl.split('?')[0];
      if (moved || u.includes('/auth/callback') || u.includes('localhost') || u.includes('127.0.0.1')) {
        cliLog('TRANSITION after ' + (i + 1) + 's url=' + maskUrl(u) + ' title=' + ni.title);
        const det = await js(String.raw\`(() => { const b = document.body.innerText || ''; return JSON.stringify({ consent: /Allow|Authorize|授权|允许|Accept|Continue/.test(b), pass: !!document.querySelector('input[type="password"]'), err500: /HTTP ERROR 500|无法正常运作/.test(b) }); })()\`);
        cliLog('DETECT=' + det);
        if (u.includes('/auth/callback') || u.includes('localhost') || u.includes('127.0.0.1')) cliLog('CALLBACK_REACHED');
        resolved = true;
        break;
      }
      if (/验证码|不正确|incorrect|invalid code|代码不正确|无效/i.test(body)) { cliLog('OUTCOME=code_rejected'); resolved = true; break; }
      if (i === 29) cliLog('NO_TRANSITION_30s url=' + maskUrl(u));
    }
    if (!resolved) cliLog('OUTCOME=unknown_no_transition');
  }
}
`;

const res = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write((res.stderr || "").slice(0, 3000));
process.exit(res.status ?? 1);
