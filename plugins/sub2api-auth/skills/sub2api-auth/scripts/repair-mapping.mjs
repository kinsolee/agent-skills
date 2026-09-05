// repair-mapping.mjs — attach/repair canonical model_mapping on an existing sub2api account.
// Hard Rule 19: PUT /accounts/<id> REPLACES all non-token credential fields. This script GETs
// the full current credentials and re-sends them COMPLETE plus model_mapping in one body.
// Canonical mapping is read from a healthy reference account (default refs: 158,113,124,170).
// Finishes with readback verification + SSE test (1-2 retries on transient EOF, Hard Rule 23).
// Usage: node repair-mapping.mjs <account_id> [ref_id,ref_id,...]
import { resolveConfig, getAccount, testAccount, maskEmail } from "../src/sub2api-admin-api.mjs";
const [acctId, refArg] = [process.argv[2], process.argv[3]];
if (!acctId) { console.error("usage: repair-mapping.mjs <account_id> [ref_ids]"); process.exit(2); }
const REF_IDS = (refArg || "158,113,124,170").split(",").map(Number).filter(Boolean);
const { adminBase, apiKey } = resolveConfig();

async function putAccount(id, body) {
  const res = await fetch(`${adminBase}/api/v1/admin/accounts/${id}`, {
    method: "PUT", headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`PUT ${res.status}: ${maskEmail(text).slice(0, 300)}`);
  try { const p = JSON.parse(text); return p && typeof p === "object" && "code" in p ? p.data : p; } catch { return null; }
}

const before = await getAccount(Number(acctId));
const bcreds = before.credentials || {};
async function sseTest(id) {
  for (let i = 0; i < 3; i++) {
    try { return await testAccount(id); }
    catch (e) {
      const msg = String(e.message || e);
      if (/EOF/.test(msg) && i < 2) { await new Promise((r) => setTimeout(r, 4000)); continue; }
      return { ok: false, error: msg.slice(0, 200) };
    }
  }
}
if (bcreds.model_mapping && Object.keys(bcreds.model_mapping).length >= 20) {
  const test = await sseTest(Number(acctId));
  console.log(JSON.stringify({ skipped: true, reason: "mapping already >=20", mapping_n: Object.keys(bcreds.model_mapping).length,
    test_ok: Boolean(test && test.ok !== false && (test.success === undefined || test.success)), test_error: test?.error || "" }));
  process.exit(0);
}
// canonical mapping from a healthy reference account
let canonical = null, refUsed = null;
for (const rid of REF_IDS) {
  if (rid === Number(acctId)) continue;
  try {
    const m = (await getAccount(rid)).credentials?.model_mapping;
    if (m && Object.keys(m).length >= 20) { canonical = m; refUsed = rid; break; }
  } catch { /* try next ref */ }
}
if (!canonical) { console.error("no reference account with >=20-entry mapping; aborting (fail-closed)"); process.exit(3); }

const credentials = { ...bcreds, model_mapping: canonical };
await putAccount(Number(acctId), { credentials });

let after = await getAccount(Number(acctId));
// token readback can lag briefly right after a credentials PUT — recheck before failing
for (let i = 0; i < 5 && !(after.credentials?.access_token && after.credentials?.refresh_token); i++) {
  await new Promise((r) => setTimeout(r, 3000));
  after = await getAccount(Number(acctId));
}
const acreds = after.credentials || {};
const mappingOk = acreds.model_mapping && Object.keys(acreds.model_mapping).length === Object.keys(canonical).length;
const metaFields = ["email", "plan_type", "client_id", "expires_at", "subscription_expires_at", "chatgpt_account_id", "chatgpt_user_id", "organization_id"];
const metaLost = metaFields.filter((k) => bcreds[k] != null && bcreds[k] !== "" && (acreds[k] == null || acreds[k] === ""));
const settingChanged = ["concurrency", "priority", "rate_multiplier", "proxy_id"].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
const groupsChanged = JSON.stringify(before.group_ids || []) !== JSON.stringify(after.group_ids || []);
const tokensOk = Boolean(acreds.access_token) && Boolean(acreds.refresh_token);
const report = {
  account_id: after.id, ref_used: refUsed, mapping_n: acreds.model_mapping ? Object.keys(acreds.model_mapping).length : 0,
  mapping_ok: Boolean(mappingOk), tokens_ok: tokensOk, meta_lost: metaLost, setting_changed: settingChanged,
  groups_changed: groupsChanged, email: maskEmail(acreds.email || ""), status: after.status, schedulable: after.schedulable,
};
if (!mappingOk || metaLost.length || settingChanged.length || groupsChanged || !tokensOk) {
  console.log(JSON.stringify({ repair: "FAILED_READBACK", ...report }));
  process.exit(4);
}
// SSE test with EOF retry (Hard Rule 23)
const test = await sseTest(Number(acctId));
console.log(JSON.stringify({ repair: "ok", ...report, test_ok: Boolean(test && test.ok !== false && (test.success === undefined || test.success)), test: test ? { ok: test.ok, success: test.success, error: test.error || "" } : null }));
