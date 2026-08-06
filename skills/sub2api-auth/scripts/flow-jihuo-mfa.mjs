// flow-jihuo-mfa.mjs — fragment-keyed TOTP via 2fa.jihuo.plus.
// Live-discovered 2026-08-06: 2fa.jihuo.plus auto-reads the URL fragment on DOMContentLoaded,
// strips non-[A-Za-z0-9], sets #secretInput, calls updateTOTP() which renders the 6-digit
// TOTP into #codeDisplay (formatted as "XXX XXX"). The page also shows timeRemaining for the
// 30s window. No email/secret input is needed; the URL itself is the per-account lookup key.
// Usage: node flow-jihuo-mfa.mjs <record_id> <space_id>
// (reads mfa_platform_url from Base; must include the "#<fragment>" hash)
import { execFileSync, spawnSync } from "node:child_process";
const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const TABLE = "tblV3Y2NDUvlbCVU";
const [, , rec, spaceId] = process.argv;
if (!rec || !spaceId) { console.error("usage: flow-jihuo-mfa.mjs <record_id> <space_id>"); process.exit(2); }
const j = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
  "--record-id", rec, "--format", "json", "--as", "user",
  "--field-id", "email", "--field-id", "mfa_platform_url"], { encoding: "utf8" }));
const d = j?.data || {};
const f = {};
(d.fields || []).forEach((n, i) => { f[n] = (d.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const EMAIL = txt(f.email);
// Normalize Base URL cell: strip Markdown link wrapper "(url)" if present
let MFA_URL = txt(f.mfa_platform_url);
if (MFA_URL) {
  const m = MFA_URL.match(/\((https?:\/\/[^)]+)\)/);
  if (m) MFA_URL = m[1];
}
if (!MFA_URL || !/^https?:\/\//.test(MFA_URL)) { console.error("missing or invalid mfa_platform_url"); process.exit(3); }
// Hard Rule 12: ensure hash fragment is preserved (Base cells sometimes lose it)
const frag = (() => { try { return new URL(MFA_URL).hash || ""; } catch { return ""; } })();
if (!frag || frag.length < 8) { console.error("mfa_platform_url missing per-row fragment"); process.exit(4); }
const script = `
const EMAIL = ${JSON.stringify(EMAIL)};
const MFA_URL = ${JSON.stringify(MFA_URL)};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, (m) => m.slice(0, 2) + '***' + m.slice(m.indexOf('@')));
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});
const host = (() => { try { return new URL(MFA_URL).host; } catch { return ''; } })();
let tabs = await listTabs();
let t2fa = tabs.find(t => String(t.url || '').includes(host));
if (!t2fa) {
  await openOrReuseTab(MFA_URL, { wait: true });
  await sleep(2500);
  tabs = await listTabs();
  t2fa = tabs.find(t => String(t.url || '').includes(host));
}
if (!t2fa) { cliLog('NO_JIHUO_TAB'); }
else {
  await switchTab(t2fa);
  await sleep(800);
  // probe codeDisplay + timeRemaining + secretInput
  let snap = String(await snapshotText());
  if (!/codeDisplay|code-display|当前验证码/i.test(snap)) {
    await sleep(1500);
    snap = String(await snapshotText());
  }
  const probe = await js(\`(() => {
    const d = document.getElementById('codeDisplay');
    const s = document.getElementById('secretInput');
    const t = document.getElementById('timeRemaining');
    // Note: location.hash (the URL fragment = per-account TOTP seed) is intentionally
    // omitted — Hard Rule 4 forbids token-bearing URL parts in stdout. Fragment presence
    // is validated by the host script before launching the browser.
    return JSON.stringify({
      codeText: d ? d.innerText : null,
      hasSecret: s ? (s.value || '').length : 0,
      timeText: t ? t.innerText : null,
    });
  })()\`);
  cliLog('probe=' + mask(probe).slice(0, 220));
  let code = null, countdown = null;
  for (let i = 0; i < 10; i++) {
    snap = String(await snapshotText());
    // format is "XXX XXX" then codeDisplay
    const m = snap.match(/code-display[^A-Za-z0-9]*([0-9 ]{6,8})/);
    let raw = m ? m[1] : null;
    if (!raw) {
      // fallback: any 6-digit run surrounded by non-digits
      const f = snap.match(/(?:^|\\D)(\\d{3}\\s?\\d{3})(?:\\D|$)/);
      raw = f ? f[1] : null;
    }
    if (raw) {
      const cleaned = raw.replace(/\\s+/g, '');
      if (/^\\d{6}$/.test(cleaned)) { code = cleaned; break; }
    }
    await sleep(1500);
  }
  if (!code) {
    cliLog('NO_CODE. SNAP: ' + mask(snap).slice(0, 1200));
  } else {
    // Check countdown via DOM
    const remain = await js(\`(() => { const t = document.getElementById('timeRemaining'); return t ? (t.innerText || '') : ''; })()\`);
    cliLog('code_found len=' + code.length + ' remain=' + remain);
    // If remaining <= 5s, wait for next code
    const secsMatch = String(remain).match(/(\\d+)/);
    let secs = secsMatch ? Number(secsMatch[1]) : NaN;
    if (!Number.isNaN(secs) && secs >= 0 && secs < 6) {
      cliLog('waiting ' + (secs + 2) + 's for fresh code...');
      await sleep((secs + 2) * 1000);
      const fresh = await js(\`(() => { const d = document.getElementById('codeDisplay'); return d ? d.innerText : ''; })()\`);
      const m2 = String(fresh).match(/\\d{3}\\s?\\d{3}/);
      if (m2) {
        const cleaned2 = m2[0].replace(/\\s+/g, '');
        if (/^\\d{6}$/.test(cleaned2)) { code = cleaned2; cliLog('refreshed code len=' + code.length); }
      }
    }
    const tabs2 = await listTabs();
    const mfa = tabs2.find(t => String(t.url || '').includes('/mfa-challenge/'));
    if (!mfa) { cliLog('NO_MFA_TAB url_tabs=' + tabs2.map(t => mask(String(t.url||'')).slice(0,40)).join('|')); }
    else {
      await switchTab(mfa);
      await sleep(500);
      const filled = await js(\`(() => { const el = document.querySelector('input[name="code"]'); if (!el) return -1; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, \${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value.length; })()\`);
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
  }
}
`;
const res = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write((res.stderr || "").slice(0, 1500));
process.exit(res.status ?? 1);
