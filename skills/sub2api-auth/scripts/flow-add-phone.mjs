// flow-add-phone.mjs — bind SIM phone to OpenAI auth flow (US +1, direct channel).
// Implements Hard Rules 29 / 30 / 31 from SKILL.md:
//   29. cdp('Page.reload') (NOT snapshotText(), NOT openOrReuseTab) each round to force a
//       fresh HTTP GET against the static SMS-inbox page (e.g. sms688.cc).
//   30. Click OpenAI's 重新发送短信 ONCE before polling, and re-click at ~round 6 / ~round 14
//       in case the first SMS push was suppressed by per-IP risk control. Hard-cap at 90 s.
//   31. Strip leading `1` from 11-digit "1xxxxxxxxxx" phone numbers to get the 10-digit
//       US national part; OpenAI's country dropdown does NOT include 中国.
// Live-verified 2026-08-07 on account #185 (<redacted-account>, SIM 134***16):
// SMS code round=4 elapsed=11 s after 重新发送短信 + Page.reload.
// Usage: node flow-add-phone.mjs <gpt_record_id> <sim_record_id> <space_id>
import { execFileSync, spawnSync } from "node:child_process";
const BASE = "XB3sbTJKlagVTusMWhzcYRzin4e";
const SIM_T = "tbljWgJs2iO1HeT6";
const [, , gptRec, simRec, spaceId] = process.argv;
if (!gptRec || !simRec || !spaceId) { console.error("usage: flow-add-phone.mjs <gpt_record_id> <sim_record_id> <space_id>"); process.exit(2); }
const SIM = JSON.parse(execFileSync("lark-cli", ["base", "+record-get", "--base-token", BASE, "--table-id", SIM_T,
  "--record-id", simRec, "--format", "json", "--as", "user", "--field-id", "phone_number", "--field-id", "sms_url"], { encoding: "utf8" }));
const simF = {};
(SIM.data.fields || []).forEach((n, i) => { simF[n] = (SIM.data.data || [])[0]?.[i]; });
const txt = (v) => { if (v == null) return ""; if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.text ?? "" : x)).join(""); if (typeof v === "object") return v.text ?? ""; return String(v); };
const PHONE = txt(simF.phone_number);
let SMS_URL = txt(simF.sms_url);
{ const m = SMS_URL.match(/\((https?:\/\/[^)]+)\)/); if (m) SMS_URL = m[1]; }
if (!PHONE || !SMS_URL) { console.error("sim missing phone_number or sms_url"); process.exit(3); }
let NATIONAL = PHONE;
if (NATIONAL.startsWith("+")) NATIONAL = NATIONAL.slice(1);
if (NATIONAL.startsWith("1") && NATIONAL.length === 11) NATIONAL = NATIONAL.slice(1);
if (NATIONAL.length !== 10) { console.error("expected 10-digit national part for US; got len=" + NATIONAL.length); process.exit(4); }
console.error("binding sim rec " + simRec + " (" + PHONE.slice(0,3) + "*** national=" + NATIONAL.slice(0,3) + "***)");

const SET_US_JS = "(function(){var sel=document.querySelector('select');if(!sel)return 'NO_SELECT';sel.value='US';sel.dispatchEvent(new Event('change',{bubbles:true}));return sel.value+'/'+Array.from(sel.selectedOptions).map(function(o){return o.text;}).join(',');})()";
const PHONE_FILL_JS = `(function(){var el=document.querySelector('input[name="__reservedForPhoneNumberInput_tel"]');if(!el){var ins=document.querySelectorAll('input');for(var i=0;i<ins.length;i++){var ph=ins[i].getAttribute('placeholder')||ins[i].getAttribute('aria-label')||'';if(ph.indexOf('电话')!==-1||ph.indexOf('号码')!==-1){el=ins[i];break;}}}if(!el)return 'NO_TEL';var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;setter.call(el,${JSON.stringify(NATIONAL)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({len:el.value.length,val:el.value});})()`;
const SUBMIT_JS = "(function(){var f=document.querySelector('form');if(!f)return 'no_form';var btns=f.querySelectorAll('button');var b=null;for(var i=0;i<btns.length;i++){var t=btns[i].innerText||btns[i].textContent||'';if(t.indexOf('继续')!==-1||t.indexOf('Continue')!==-1){b=btns[i];break;}}if(!b)b=btns[btns.length-1];try{f.requestSubmit(b);return 'submitted';}catch(e){return 'err:'+e.message;}})()";
const RADIO_PICK_JS = "(function(){var rs=document.querySelectorAll('[role=radio],input[type=radio]');var m=null;for(var i=0;i<rs.length;i++){var t=(rs[i].innerText||rs[i].textContent||'')+'|'+(rs[i].getAttribute('aria-label')||'');if(t.indexOf('短信')!==-1){m=rs[i];break;}}if(!m)return 'NO_SMS_RADIO';if(m.getAttribute&&m.getAttribute('aria-checked')==='false')m.click();else m.click();return 'sms_clicked';})()";

const script = `
const SMS_URL = ${JSON.stringify(SMS_URL)};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, (m) => m.slice(0, 2) + '***' + m.slice(m.indexOf('@')));
await useOrCreateTaskSpace(${JSON.stringify(Number(spaceId))});

async function snap() { return String(await snapshotText()); }
async function switchToTabMatching(testFn) {
  const tabs = await listTabs();
  const t = tabs.find(x => testFn(String(x.url || '')));
  if (t) { await switchTab(t); return true; }
  return false;
}
async function realReloadCurrentTab() {
  // cdp('Page.reload') triggers an actual HTTP GET on the current active tab.
  // openOrReuseTab is NOT a refresh — it only reuses existing tabs.
  return await cdp('Page.reload', { ignoreCache: false });
}

// Phase 1: navigate to /add-phone (or stay where we are if already there)
let onPV = false;
for (let i = 0; i < 10; i++) {
  if (await switchToTabMatching(u => u.indexOf('/phone-verification') !== -1)) { onPV = true; break; }
  break;
}
if (!onPV) {
  for (let i = 0; i < 10; i++) {
    if (await switchToTabMatching(u => u.indexOf('/add-phone') !== -1)) break;
    break;
  }
  await sleep(800);
  cliLog('STEP url=' + (await pageInfo()).url);

  // Force country to US in case prior runs left it on another country
  const setUS = await js(${JSON.stringify(SET_US_JS)});
  cliLog('set_us=' + setUS);
  await sleep(500);

  const phoneFill = await js(${JSON.stringify(PHONE_FILL_JS)});
  cliLog('phone_filled=' + phoneFill);
  await sleep(800);

  const radioPick = await js(${JSON.stringify(RADIO_PICK_JS)});
  cliLog('radio_sms=' + radioPick);
  await sleep(500);

  const subRes = await js(${JSON.stringify(SUBMIT_JS)});
  cliLog('phone_submit=' + subRes);

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const u = String((await pageInfo()).url || '');
    if (u.indexOf('/phone-verification') !== -1) { cliLog('PHONE_VERIF after ' + (i + 1) + 's'); onPV = true; break; }
  }
}

if (!onPV) { cliLog('NO_PHONE_VERIF'); }
else {
  await switchToTabMatching(u => u.indexOf('/phone-verification') !== -1);
  await sleep(800);
  cliLog('ON_PV url=' + (await pageInfo()).url);

  // Phase 2: click OpenAI's 重新发送短信 first so OpenAI actually pushes the SMS.
  // (OpenAI does not always auto-send on entering phone-verification.)
  const resendPre = await js("(function(){var btns=document.querySelectorAll('button');var m=null;for(var i=0;i<btns.length;i++){var t=btns[i].innerText||btns[i].textContent||'';if(t.indexOf('重新发送')!==-1){m=btns[i];break;}}if(!m)return 'NO_RESEND';try{m.click();return 'sent_pre';}catch(e){return 'err:'+e.message;}})()");
  cliLog('resend_pre=' + resendPre);
  await sleep(3000);

  // Phase 3: open SMS URL fresh in its own tab
  await openOrReuseTab(SMS_URL, { wait: true });
  await sleep(3500);
  const smsTab = (await listTabs()).find(x => String(x.url||'').indexOf(new URL(SMS_URL).host) !== -1);
  if (!smsTab) { cliLog('NO_SMS_TAB'); }
  else {
    let code = null, lastSnap = '', firstCode = null;
    const HARD_CAP_MS = 90000;
    const startTs = Date.now();
    for (let i = 0; i < 30; i++) {
      if (Date.now() - startTs > HARD_CAP_MS) { cliLog('hard_cap ' + (Math.round((Date.now()-startTs)/1000)) + 's'); break; }
      // Switch to SMS tab and force a REAL HTTP reload
      await switchTab(smsTab);
      await sleep(200);
      try { await realReloadCurrentTab(); } catch (e) { cliLog('reload_err round=' + (i+1) + ' ' + e.message.slice(0,80)); }
      await sleep(2500);
      const s = await snap();
      lastSnap = s;
      const arr = s.match(/(?:[^0-9]([0-9]{6})[^0-9])/);
      if (arr) {
        const cand = arr[1];
        if (!firstCode) firstCode = cand;
        // Hard Rule 24: prefer the second distinct code (first display is often stale)
        if (cand !== firstCode || i >= 3) { code = cand; cliLog('SMS code round=' + (i + 1) + ' elapsed=' + (Math.round((Date.now()-startTs)/1000)) + 's'); break; }
      }
      // Periodic OpenAI re-send if first push was suppressed by risk control
      if (i === 6 || i === 14) {
        const pvT = (await listTabs()).find(x => String(x.url||'').indexOf('/phone-verification') !== -1);
        if (pvT) {
          await switchTab(pvT); await sleep(300);
          await js("(function(){var btns=document.querySelectorAll('button');var m=null;for(var i=0;i<btns.length;i++){var t=btns[i].innerText||btns[i].textContent||'';if(t.indexOf('重新发送')!==-1){m=btns[i];break;}}if(!m)return 'NO_RESEND';try{m.click();return 'sent_round'+" + (i+1) + ";}catch(e){return 'err';}})()");
          await switchTab(smsTab);
        }
      }
    }
    if (!code) { cliLog('NO_SMS_CODE elapsed=' + (Math.round((Date.now()-startTs)/1000)) + 's snap=' + mask(lastSnap).slice(0, 500)); }
    else {
      // Phase 4: switch to phone-verification, fill+submit code
      const pv = (await listTabs()).find(x => String(x.url||'').indexOf('/phone-verification') !== -1);
      if (!pv) { cliLog('NO_PV_TAB'); }
      else {
        await switchTab(pv);
        await sleep(800);
        const fillCode = await js("(() => { var el = document.querySelector('input[name=\\\"code\\\"]'); if (!el) return -1; var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, " + JSON.stringify(code) + "); el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); return el.value.length; })()");
        cliLog('pv_code_filled=' + fillCode);
        const subPV = await js(${JSON.stringify(SUBMIT_JS)});
        cliLog('pv_submit=' + subPV);
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const u = String((await pageInfo()).url || '');
          if (u.indexOf('/phone-verification') === -1) { cliLog('PV_TRANS after ' + (i + 1) + 's url=' + u); break; }
          if (i === 29) cliLog('STILL_PV url=' + u);
        }
        const inf = await pageInfo();
        cliLog('final_url=' + inf.url + ' title=' + inf.title);
        cliLog('SNAP: ' + mask(await snap()).slice(0, 1500));
      }
    }
  }
}
`;
const res = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write((res.stderr || "").slice(0, 1500));
process.exit(res.status ?? 1);
