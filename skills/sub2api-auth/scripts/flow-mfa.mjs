// flow-mfa.mjs — TOTP via email-keyed platform (2fa.nloop.cc): JSON API lookup, fill, submit.
// Live-verified 2026-08-04/05/06 (browser query path). 2026-08-12: code fetch moved to the
// platform's keyless JSON API after the UI query returned 0 rows for accounts whose API records
// exist (OpenCodex reauth batch, 4/4 found). API contract: GET <platform>/api/mfa/lookup?email=…
// → { ok, email, found, results: [{ service, email, note, code, remaining, period }] }.
// Browser work is only fill+submit on the OpenAI mfa-challenge tab. Code stays process-local
// (Hard Rule 22) and never appears in cliLog/stdout.
// Usage: node flow-mfa.mjs <record_id> <space_id> [platform_url]
import { execFileSync, spawnSync } from "node:child_process";
import { resolveBase } from "./feishu-base.mjs";
const { baseToken: BASE, gptAccountsTableId: TABLE } = resolveBase();
const [, , rec, spaceId, platformUrl] = process.argv;
if (!rec || !spaceId) { console.error("usage: flow-mfa.mjs <record_id> <space_id> [platform_url]"); process.exit(2); }
const PLATFORM = platformUrl || "https://2fa.nloop.cc/";
const API_ORIGIN = new URL(PLATFORM).origin;
const j = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
  "--record-id", rec, "--format", "json", "--as", "user", "--field-id", "email"], { encoding: "utf8" }));
const d = j?.data || {};
const f = {};
(d.fields || []).forEach((n, i) => { f[n] = (d.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const EMAIL = txt(f.email);
if (!EMAIL) { console.error("no email"); process.exit(3); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lookup() {
  const res = await fetch(API_ORIGIN + "/api/mfa/lookup?email=" + encodeURIComponent(EMAIL), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 200) return { status: "http_" + res.status };
  const body = await res.json();
  if (body.ok !== true) return { status: "api_not_ok", error: body.error ?? null };
  if (!body.found || !Array.isArray(body.results) || body.results.length === 0) return { status: "not_found" };
  const first = body.results[0];
  if (!/^\d{6,8}$/.test(first.code ?? "")) return { status: "bad_code" };
  return { status: "ok", code: first.code, remaining: Number(first.remaining), period: Number(first.period), records: body.results.length };
}
let got = await lookup();
if (got.status === "ok" && Number.isFinite(got.remaining) && got.remaining >= 0 && got.remaining < 5) {
  console.log("code_refresh_wait remaining=" + got.remaining + "s");
  await sleep((got.remaining + 2) * 1000);
  got = await lookup();
}
if (got.status !== "ok") {
  console.log("api_lookup=" + got.status + (got.error ? " error=" + got.error : ""));
  process.exit(4);
}
console.log("api_lookup=ok len=" + got.code.length + " remaining=" + got.remaining + "s period=" + got.period + "s records=" + got.records);
const script = `
const CODE = ${JSON.stringify(got.code)};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, (x) => x.slice(0, 2) + '***' + x.slice(x.indexOf('@')));
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});
const tabs = await listTabs();
const mfa = tabs.find(t => String(t.url || '').includes('/mfa-challenge/'));
if (!mfa) { cliLog('NO_MFA_TAB'); }
else {
  await switchTab(mfa);
  await sleep(500);
  const filled = await js(\`(() => { const el = document.querySelector('input[name="code"]'); if (!el) return -1; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, \${JSON.stringify(CODE)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value.length; })()\`);
  cliLog('code_filled_len=' + filled);
  const sub = await js(String.raw\`(() => { const form = document.querySelector('form'); if (!form) return 'no_form'; const btn = document.querySelector('button[name="intent"]') || form.querySelector('button'); try { form.requestSubmit(btn); return 'submitted'; } catch (e) { return 'err:' + e.message; } })()\`);
  cliLog('mfa_submit=' + sub);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const info = await pageInfo();
    if (!String(info.url).includes('/mfa-challenge')) { cliLog('TRANSITION after ' + (i + 1) + 's url=' + info.url + ' title=' + info.title); break; }
    if (i === 19) cliLog('STILL_MFA title=' + info.title);
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
