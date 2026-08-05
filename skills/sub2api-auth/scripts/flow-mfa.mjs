// flow-mfa.mjs — TOTP via email-keyed platform (2fa.nloop.cc): query by email, fill, submit.
// Live-verified 2026-08-04/05/06. Anchors on unique 等待邮箱 text (first 粘贴邮箱 occurrence is
// descriptive copy). Code stays process-local. Usage: node flow-mfa.mjs <record_id> <space_id> [platform_url]
import { execFileSync, spawnSync } from "node:child_process";
const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const TABLE = "tblV3Y2NDUvlbCVU";
const [, , rec, spaceId, platformUrl] = process.argv;
if (!rec || !spaceId) { console.error("usage: flow-mfa.mjs <record_id> <space_id> [platform_url]"); process.exit(2); }
const PLATFORM = platformUrl || "https://2fa.nloop.cc/";
const j = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", TABLE,
  "--record-id", rec, "--format", "json", "--as", "user", "--field-id", "email"], { encoding: "utf8" }));
const d = j?.data || {};
const f = {};
(d.fields || []).forEach((n, i) => { f[n] = (d.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const EMAIL = txt(f.email);
if (!EMAIL) { console.error("no email"); process.exit(3); }
const script = `
const EMAIL = ${JSON.stringify(EMAIL)};
const PLATFORM = ${JSON.stringify(PLATFORM)};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, (x) => x.slice(0, 2) + '***' + x.slice(x.indexOf('@')));
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});
let tabs = await listTabs();
let t2fa = tabs.find(t => String(t.url || '').includes(new URL(PLATFORM).host));
if (!t2fa) {
  await openOrReuseTab(PLATFORM, { wait: true });
  await sleep(3500);
  tabs = await listTabs();
  t2fa = tabs.find(t => String(t.url || '').includes(new URL(PLATFORM).host));
}
if (!t2fa) { cliLog('NO_2FA_TAB'); }
else {
  await switchTab(t2fa);
  await sleep(500);
  let snap = String(await snapshotText());
  const anchor = snap.indexOf('等待邮箱');
  if (anchor < 0) { cliLog('STOP: 等待邮箱 anchor missing — re-observe the platform page'); }
  else {
    const m = snap.slice(anchor, anchor + 400).match(/textbox \\[ref=(\\d+)/);
    cliLog('query_input_ref=' + (m ? m[1] : 'NOT_FOUND'));
    if (m) {
      await fillInput('@' + m[1], EMAIL);
      await sleep(4000);
      let code = null, countdown = null;
      for (let i = 0; i < 8; i++) {
        snap = String(await snapshotText());
        const panelIdx = snap.indexOf('container "验证码"');
        const panel = snap.slice(panelIdx);
        const cm = panel.match(/"(\\d{6})"/);
        const dm = panel.match(/(\\d+)\\s*秒/);
        if (cm) { code = cm[1]; countdown = dm ? dm[1] : '?'; break; }
        await sleep(2000);
      }
      if (!code) {
        const panelIdx = snap.indexOf('container "验证码"');
        cliLog('NO_CODE. PANEL: ' + mask(snap.slice(panelIdx, panelIdx + 1000)));
      } else {
        cliLog('code_found len=' + code.length + ' countdown=' + countdown + 's');
        const secs = Number(countdown);
        if (!Number.isNaN(secs) && secs >= 0 && secs < 5) {
          cliLog('waiting for fresh code...');
          await sleep((secs + 2) * 1000);
          snap = String(await snapshotText());
          const panelIdx = snap.indexOf('container "验证码"');
          const cm2 = snap.slice(panelIdx).match(/"(\\d{6})"/);
          if (cm2) { code = cm2[1]; cliLog('refreshed code len=' + code.length); }
        }
        const tabs2 = await listTabs();
        const mfa = tabs2.find(t => String(t.url || '').includes('/mfa-challenge/'));
        if (!mfa) { cliLog('NO_MFA_TAB'); }
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
  }
}
`;
const res = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write((res.stderr || "").slice(0, 1500));
process.exit(res.status ?? 1);
