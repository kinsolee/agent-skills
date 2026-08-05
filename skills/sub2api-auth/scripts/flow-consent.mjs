// flow-consent.mjs — consent gate + callback capture + sub2api create/apply.
// Identity gate (Hard Rule 16): consent page must show the exact Base email before clicking.
// Callback recovered from current URL or CDP Page.getNavigationHistory (ERR_CONNECTION_REFUSED
// is expected: nothing listens on localhost:1455). Code/state travel only as B64 markers in
// cliLog; those lines are filtered from echoed output before parsing (Hard Rule 4).
// Usage:
//   node flow-consent.mjs <record_id> <space_id> --mode create --session-id <sid>
//   node flow-consent.mjs <record_id> <space_id> --mode apply --id <acct> --session-id <sid>
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const TABLE = "tblV3Y2NDUvlbCVU";
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sub2api-admin-api.mjs");
const argv = process.argv.slice(2);
const rec = argv[0], spaceId = argv[1];
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const mode = opt("--mode"), sessionId = opt("--session-id"), acctId = opt("--id");
if (!rec || !spaceId || !mode || !sessionId || (mode === "apply" && !acctId)) {
  console.error("usage: flow-consent.mjs <record_id> <space_id> --mode create|apply --session-id <sid> [--id <acct>]");
  process.exit(2);
}
const j = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
  "--record-id", rec, "--format", "json", "--as", "user", "--field-id", "email"], { encoding: "utf8" }));
const d = j?.data || {};
const f = {};
(d.fields || []).forEach((n, i) => { f[n] = (d.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const EMAIL = txt(f.email);
if (!EMAIL) { console.error("no email in Base record"); process.exit(3); }
const script = `
const EMAIL = ${JSON.stringify(EMAIL)};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, (x) => x.slice(0, 2) + '***' + x.slice(x.indexOf('@')));
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});
let cb = null;
const urlOf = async () => { try { return String((await pageInfo()).url || ''); } catch { return ''; } };
// already on callback (e.g. consent clicked in a previous round)?
if (/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/auth\\/callback/.test(await urlOf())) cb = await urlOf();
if (!cb) {
  const text = await js(String.raw\`document.body.innerText || ''\`);
  const emails = [...new Set(String(text).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g) || [])];
  if (!emails.includes(EMAIL)) {
    cliLog('IDENTITY_MISMATCH found=' + JSON.stringify(emails.map(mask)) + ' url=' + mask(await urlOf()));
    cliLog('SNAP: ' + mask(String(await snapshotText())).slice(0, 900));
  } else {
    cliLog('identity_ok ' + mask(EMAIL));
    const clicked = await js(String.raw\`(() => { const btns = [...document.querySelectorAll('button')].filter(b => /Continue|继续|Allow|Authorize|授权|Accept/i.test(b.innerText || '')); if (!btns.length) return 'no_consent_btn'; const b = btns.find(x => x.type === 'submit') || btns[btns.length - 1]; b.click(); return 'clicked:' + (b.innerText || '').trim().slice(0, 24); })()\`);
    cliLog('consent=' + clicked);
    if (!String(clicked).startsWith('no_consent_btn')) {
      for (let i = 0; i < 25; i++) {
        await sleep(1000);
        const u = await urlOf();
        if (/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/auth\\/callback/.test(u)) { cb = u; cliLog('CALLBACK_DIRECT after ' + (i + 1) + 's'); break; }
      }
    }
  }
}
if (!cb) {
  // Chromium error page (ERR_CONNECTION_REFUSED): recover the original callback from nav history.
  try {
    const hist = await cdp('Page.getNavigationHistory');
    const entries = (hist && hist.entries) || [];
    const hits = entries.filter(e => /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/auth\\/callback\\?/.test(String(e.url || '')));
    if (hits.length === 1) { cb = hits[0].url; cliLog('CALLBACK_FROM_HISTORY'); }
    else cliLog('HISTORY_AMBIGUOUS n=' + hits.length);
  } catch (e) { cliLog('HISTORY_ERR ' + e.message); }
}
if (!cb) {
  const info = await pageInfo();
  cliLog('NO_CALLBACK url=' + info.url + ' title=' + info.title);
  cliLog('SNAP: ' + mask(String(await snapshotText())).slice(0, 1200));
} else {
  const q = new URL(cb).searchParams;
  const code = q.get('code'), state = q.get('state');
  if (!code || !state) { cliLog('CALLBACK_MALFORMED keys=' + [...q.keys()].join(',')); }
  else { cliLog('B64CODE=' + btoa(code)); cliLog('B64STATE=' + btoa(state)); }
}
`;
const res = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
const combined = `${res.stdout || ""}${res.stderr || ""}`;
const b64code = (combined.match(/B64CODE=([A-Za-z0-9+/=]+)/) || [])[1];
const b64state = (combined.match(/B64STATE=([A-Za-z0-9+/=]+)/) || [])[1];
// echo everything except the secret marker lines
const echo = combined.split("\n").filter((l) => !/^(B64CODE|B64STATE)=/.test(l)).join("\n");
if (echo.trim()) process.stderr.write(echo.slice(0, 3000) + "\n");
if (!b64code || !b64state) { console.error("no callback captured"); process.exit(res.status || 4); }
const code = Buffer.from(b64code, "base64").toString("utf8");
const state = Buffer.from(b64state, "base64").toString("utf8");
const args = mode === "create"
  ? ["create", "--name", EMAIL, "--session-id", sessionId, "--code", code, "--state", state,
     "--proxy-id", "1", "--group-ids", "2", "--concurrency", "10", "--priority", "1", "--raw"]
  : ["apply", "--id", acctId, "--session-id", sessionId, "--code", code, "--state", state, "--raw"];
const api = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
if (api.status !== 0) {
  console.error("admin-api failed");
  if (api.stderr) process.stderr.write(String(api.stderr).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (x) => x.slice(0, 2) + "***" + x.slice(x.indexOf("@"))).slice(0, 1500));
  process.exit(api.status || 5);
}
let out = {};
try { out = JSON.parse(api.stdout); } catch { console.error("bad api json"); process.exit(6); }
const acct = out.id ? out : out.account || out;
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (x) => x.slice(0, 2) + "***" + x.slice(x.indexOf("@")));
console.log(JSON.stringify({
  mode, account_id: acct.id ?? null, email: mask(acct.name || acct.credentials?.email || EMAIL),
  status: acct.status ?? null, schedulable: acct.schedulable ?? null, error: acct.error || "",
  has_access_token: Boolean(acct.credentials?.access_token ?? acct.credentials_status?.has_access_token),
  has_refresh_token: Boolean(acct.credentials?.refresh_token ?? acct.credentials_status?.has_refresh_token),
  has_model_mapping: Boolean(acct.credentials?.model_mapping),
}));
