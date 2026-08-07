// flow-totp-local.mjs — compute TOTP locally from Base mfa_secret and fill it on the OpenAI
// MFA challenge page. Live driver for secret-keyed 2FA accounts (Hard Rule 17 secret-keyed path).
// Algorithm: RFC 6238 TOTP (HMAC-SHA1, 30 s window, 6 digits) over the Base32-decoded mfa_secret.
// Sanity-checked against the RFC 6238 SHA1 vector at T=59 (secret "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
// -> 287082) when this script was added 2026-08-07.
// Usage: node flow-totp-local.mjs <gpt_record_id> <space_id>
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const TABLE = "tblV3Y2NDUvlbCVU";
const [, , rec, spaceId] = process.argv;
if (!rec || !spaceId) { console.error("usage: flow-totp-local.mjs <record_id> <space_id>"); process.exit(2); }
const j = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
  "--record-id", rec, "--format", "json", "--as", "user", "--field-id", "email", "--field-id", "mfa_secret"], { encoding: "utf8" }));
const d = j?.data || {};
const f = {};
(d.fields || []).forEach((n, i) => { f[n] = (d.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const EMAIL = txt(f.email);
const SECRET = txt(f.mfa_secret).replace(/\s+/g, "").toUpperCase().replace(/=+$/, "");
if (!SECRET) { console.error("missing mfa_secret in Base"); process.exit(3); }

function base32Decode(s) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  s = s.replace(/=+$/, "");
  let bits = "";
  for (const ch of s) {
    const v = alpha.indexOf(ch);
    if (v < 0) throw new Error("invalid base32 char: " + ch);
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}
function totp(secret, nowSec = Math.floor(Date.now() / 1000)) {
  const counter = Math.floor(nowSec / 30);
  const counterBuf = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { counterBuf[i] = c & 0xff; c = Math.floor(c / 256); }
  const key = base32Decode(secret);
  const h = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % 1000000).padStart(6, "0");
}
const CODE = totp(SECRET);
console.error(`totp code computed for ${EMAIL.slice(0, 3)}*** (len=${CODE.length})`);

const script = `
const EMAIL = ${JSON.stringify(EMAIL)};
const CODE = ${JSON.stringify(CODE)};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, (m) => m.slice(0, 2) + '***' + m.slice(m.indexOf('@')));
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});
const tabs = await listTabs();
const mfa = tabs.find(t => String(t.url || '').includes('/mfa-challenge'));
if (!mfa) { cliLog('NO_MFA_TAB tabs=' + tabs.map(t => mask(String(t.url||'')).slice(0,40)).join('|')); }
else {
  await switchTab(mfa);
  await sleep(500);
  const fillRes = await js(String.raw\`(() => { const el = document.querySelector('input[name="code"]'); if (!el) return -1; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, \${JSON.stringify(CODE)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value.length; })()\`);
  cliLog('code_filled_len=' + fillRes + '/6');
  if (fillRes !== 6) { cliLog('BAD_FILL abort'); }
  else {
    const sub = await js(String.raw\`(() => { const form = document.querySelector('form'); if (!form) return 'no_form'; const btn = document.querySelector('button[name="intent"]') || form.querySelector('button'); try { form.requestSubmit(btn); return 'submitted'; } catch (e) { return 'err:' + e.message; } })()\`);
    cliLog('mfa_submit=' + sub);
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const info = await pageInfo();
      if (!String(info.url).includes('/mfa-challenge')) { cliLog('TRANSITION after ' + (i + 1) + 's url=' + info.url + ' title=' + info.title); break; }
      if (i === 24) cliLog('STILL_MFA title=' + info.title);
    }
    const info = await pageInfo();
    cliLog('final_url=' + info.url + ' title=' + info.title);
    cliLog('SNAP: ' + mask(await snapshotText()).slice(0, 1800));
  }
}
`;
const res = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write((res.stderr || "").slice(0, 1500));
process.exit(res.status ?? 1);
