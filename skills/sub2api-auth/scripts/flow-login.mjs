// flow-login.mjs — OpenAI login driver (fresh auth-URL load → email → password → next state).
// Live-verified 2026-08-05/06 (Hard Rules 14/15/23). Secrets stay in memory: read from Base,
// embedded via JSON.stringify into the piped ego-browser script. No disk, no command text.
// Usage: node flow-login.mjs <gpt_record_id> <space_id> <auth_file.json>
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const TABLE = "tblV3Y2NDUvlbCVU";
const [, , rec, spaceId, authFile] = process.argv;
if (!rec || !spaceId || !authFile) { console.error("usage: flow-login.mjs <record_id> <space_id> <auth_file>"); process.exit(2); }
const j = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
  "--record-id", rec, "--format", "json", "--as", "user", "--field-id", "email", "--field-id", "password"], { encoding: "utf8" }));
const d = j?.data || {};
const f = {};
(d.fields || []).forEach((n, i) => { f[n] = (d.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const EMAIL = txt(f.email);
const PASS = txt(f.password);
const AUTH_URL = JSON.parse(readFileSync(authFile, "utf8")).authUrl;
if (!EMAIL || !PASS || !AUTH_URL) { console.error("missing inputs"); process.exit(3); }
const script = `
const EMAIL = ${JSON.stringify(EMAIL)};
const PASS = ${JSON.stringify(PASS)};
const AUTH_URL = ${JSON.stringify(AUTH_URL)};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, (m) => m.slice(0, 2) + '***' + m.slice(m.indexOf('@')));
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});
// fresh load (Hard Rule 23): never submit forms on a retry-restored page
await openOrReuseTab(AUTH_URL, { wait: true });
await sleep(4000);
const elen = await js(String.raw\`(() => { const el = document.querySelector('input[name="email"]'); if (!el) return -1; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, ${JSON.stringify(EMAIL)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value.length; })()\`);
cliLog('email_len=' + elen + '/' + EMAIL.length);
const esub = await js(String.raw\`(() => { const form = document.querySelector('form'); if (!form) return 'no_form'; const btn = [...form.querySelectorAll('button')].find(x => /继续|Continue|Next/.test(x.innerText || '')) || document.querySelector('button[name="intent"]'); try { form.requestSubmit(btn); return 'submitted'; } catch (e) { return 'err:' + e.message; } })()\`);
cliLog('email_submit=' + esub);
let passReady = false;
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  const hp = await js(String.raw\`!!document.querySelector('input[name="current-password"], input[type="password"]')\`);
  if (hp) { passReady = true; cliLog('password_field after ' + (i + 1) + 's'); break; }
  const err = await js(String.raw\`/糟糕|Operation timed out/.test(document.body.innerText || '')\`);
  if (err) { cliLog('ERROR_PAGE after email step'); break; }
}
if (!passReady) {
  const info = await pageInfo();
  cliLog('NO_PASSWORD url=' + info.url + ' title=' + info.title);
  cliLog('SNAP: ' + mask(await snapshotText()).slice(0, 900));
} else {
  await sleep(1000);
  const plen = await js(String.raw\`(() => { const el = document.querySelector('input[name="current-password"]') || document.querySelector('input[type="password"]'); if (!el) return -1; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, ${JSON.stringify(PASS)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value.length; })()\`);
  cliLog('pass_len=' + plen + '/' + PASS.length);
  const psub = await js(String.raw\`(() => { const form = document.querySelector('form'); if (!form) return 'no_form'; const btn = document.querySelector('button[name="intent"]') || form.querySelector('button[type="submit"]') || form.querySelector('button'); try { form.requestSubmit(btn); return 'submitted'; } catch (e) { return 'err:' + e.message; } })()\`);
  cliLog('pass_submit=' + psub);
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const info = await pageInfo();
    const u = info.url || '';
    if (!u.includes('/log-in/password')) { cliLog('TRANSITION after ' + (i + 1) + 's url=' + u + ' title=' + info.title); break; }
    if (i === 24) cliLog('STILL_PASSWORD after 25s title=' + info.title);
  }
  const info = await pageInfo();
  cliLog('final_url=' + info.url + ' title=' + info.title);
  cliLog('SNAP: ' + mask(await snapshotText()).slice(0, 1600));
}
`;
const res = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write((res.stderr || "").slice(0, 1500));
process.exit(res.status ?? 1);
