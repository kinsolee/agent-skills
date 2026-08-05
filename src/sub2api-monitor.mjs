// sub2api-monitor.mjs — hourly health/capacity monitor for the sub2api fleet.
//
// Modules (per user spec 2026-08-04):
//   1a. Expired accounts   -> delete from sub2api + Base sub2api_status=过期 (readback both)
//   1b. Error-state accts  -> silent admin-API reauth (refresh):
//         refresh OK + paid plan  -> clear-error, verify, test, restore schedulable, Base active
//         refresh OK + free plan  -> Base 失效 + removal queue (subscription gone)
//         refresh FAILED          -> flag for interactive Flow C reauth (browser; cannot run unattended)
//   1c. Config check       -> proxy_id / group_ids / model_mapping / schedulable vs canonical (report-only)
//   2.  Capacity           -> healthy accounts: available% per 5h & 7d windows; alert when
//                             available < MIN_AVAILABLE (default 80%, configurable)
//
// All sub2api mutations go through the admin API helper (Hard Rule 20). No
// credentials PUT anywhere in this script (Hard Rule 19): config problems are
// reported, never auto-repaired with a full-body PUT, except the dedicated
// safe endpoints (schedulable toggle on the 1b recovery path).
//
// Outputs: human-readable masked report on stdout, JSON report at
// state/monitor-report-latest.json, persistent queue at state/monitor-state.json.
// Secrets policy: emails masked, tokens/passwords never printed (Hard Rule 4).
//
// Usage:
//   node src/sub2api-monitor.mjs [--dry-run] [--min-available 80] [--skip-usage-probe] [--json]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listAccounts, getAccount, refreshAccount, clearAccountError,
  getAccountUsage, deleteAccount, setSchedulable, testAccount,
  verificationReport, maskEmail,
} from "../skills/sub2api-auth/src/sub2api-admin-api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STATE_DIR = path.join(ROOT, "state");
const STATE_FILE = path.join(STATE_DIR, "monitor-state.json");
const REPORT_FILE = path.join(STATE_DIR, "monitor-report-latest.json");

// --- canonical fleet configuration (matches onboarded state, Flow B/C) -----
const CANONICAL_PROXY_ID = 1;
const CANONICAL_GROUP_IDS = [2];
const CANONICAL_MAPPING_SIZE = 20;
const BASE_TITLE = "sub2api-auth";
const BASE_TABLE = "tblV3Y2NDUvlbCVU"; // gpt_accounts
const USAGE_FRESH_MS = 90 * 60 * 1000; // probe only when cached usage is older
const PAID_PLANS = new Set(["plus", "pro", "plus_plus", "team", "business", "enterprise"]);

// --- CLI args ---------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const SKIP_USAGE_PROBE = argv.includes("--skip-usage-probe");
const JSON_ONLY = argv.includes("--json");
const MIN_AVAILABLE = (() => {
  const i = argv.indexOf("--min-available");
  if (i >= 0 && argv[i + 1] !== undefined) return Number(argv[i + 1]);
  if (process.env.S2A_TOKEN_ALERT_MIN_AVAILABLE) return Number(process.env.S2A_TOKEN_ALERT_MIN_AVAILABLE);
  return 80;
})();

const nowLocal = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const mask = (v) => (typeof v === "string" ? maskEmail(v) : v);
const maskAcct = (a) => mask((a && (a.name || (a.credentials && a.credentials.email))) || "?");

function parseTime(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // epoch seconds or ms
  if (/^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// --- state ------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { removal_queue: [], needs_interactive_reauth: [], last_run: null };
  }
}
function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  if (DRY_RUN) return;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// --- Feishu Base helpers (via lark-cli) --------------------------------------
function lark(args) {
  const out = execFileSync("lark-cli", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}
let baseTokenCache = null;
function baseToken() {
  if (baseTokenCache) return baseTokenCache;
  const j = lark(["base", "+title-resolve", "--title", BASE_TITLE, "--as", "user", "--format", "json"]);
  baseTokenCache = j.data.base_token;
  return baseTokenCache;
}

// Load all gpt_accounts rows once per run: email(lower) -> {record_id, status, notes}
function loadBaseIndex() {
  const index = new Map();
  let offset = 0;
  for (;;) {
    const j = lark([
      "base", "+record-list", "--base-token", baseToken(), "--table-id", BASE_TABLE,
      "--field-id", "email", "--field-id", "sub2api_status", "--field-id", "notes",
      "--limit", "200", "--offset", String(offset), "--as", "user", "--format", "json",
    ]);
    const d = j.data || {};
    const names = (d.fields || []).map((f) => f.field_name || f.name || f);
    const rows = d.data || [];
    const cellText = (c) => {
      if (c == null) return "";
      if (Array.isArray(c)) return c.map((x) => (x && x.text !== undefined ? x.text : x && x.name !== undefined ? x.name : String(x ?? ""))).flat().join("");
      if (typeof c === "object") return c.text !== undefined ? String(c.text) : JSON.stringify(c);
      return String(c);
    };
    const ids = d.record_id_list || [];
    rows.forEach((row, i) => {
      const rec = { record_id: ids[i], status: "", notes: "" };
      names.forEach((n, k) => {
        if (n === "email") rec.email = cellText(row[k]).trim().toLowerCase();
        else if (n === "sub2api_status") rec.status = cellText(row[k]).trim();
        else if (n === "notes") rec.notes = cellText(row[k]);
      });
      if (rec.email) index.set(rec.email, rec);
    });
    if (!d.has_more) break;
    offset += 200;
    if (offset > 2000) break; // safety
  }
  return index;
}

function baseUpdate(record, fields, noteAppend) {
  const payload = { ...fields };
  if (noteAppend) {
    const notes = `${record.notes ? record.notes + "\n" : ""}[${nowLocal()} monitor] ${noteAppend}`;
    payload.notes = notes;
  }
  if (DRY_RUN) return { dry_run: true, payload: { ...payload, notes: payload.notes ? "(appended)" : undefined } };
  const j = lark([
    "base", "+record-upsert", "--base-token", baseToken(), "--table-id", BASE_TABLE,
    "--record-id", record.record_id, "--json", JSON.stringify(payload), "--as", "user", "--format", "json",
  ]);
  if (!j.ok) throw new Error(`base upsert failed: ${JSON.stringify(j.error || j).slice(0, 300)}`);
  record.notes = payload.notes ?? record.notes; // keep local copy fresh for further appends
  return j;
}

// --- account classification helpers ------------------------------------------
const subExpMs = (a) => parseTime(a.credentials && a.credentials.subscription_expires_at);
const planOf = (a) => String((a.credentials && a.credentials.plan_type) || "").toLowerCase();
const isPaid = (a) => PAID_PLANS.has(planOf(a));
const isExpired = (a, now) => {
  if (planOf(a) === "free") return true;
  const t = subExpMs(a);
  return t != null && t < now;
};
const accountEmail = (a) => String((a.credentials && a.credentials.email) || a.name || "").trim().toLowerCase();

// --- module result buckets ----------------------------------------------------
const report = {
  run_at: nowLocal(), dry_run: DRY_RUN, min_available: MIN_AVAILABLE,
  modules: { expired_removed: [], removed_from_queue: [], reauth_restored: [], reauth_lost_subscription: [],
    needs_interactive_reauth: [], config_issues: [], capacity_alerts: [], healthy: [] },
  errors: [],
};
const note = (mod, entry) => report.modules[mod].push(entry);

// =============================================================================
async function main() {
  const state = loadState();
  const now = Date.now();
  const list = await listAccounts({});
  const accounts = list.items || list.data?.items || [];
  const baseIndex = loadBaseIndex();
  const byEmail = new Map(accounts.map((a) => [accountEmail(a), a]));

  // ---- Module 1b: error-state accounts -> silent reauth attempt ------------
  const errorAccounts = accounts.filter((a) => a.status !== "active" || (a.error_message && a.error_message.trim()));
  const handledIds = new Set();
  for (const a of errorAccounts) {
    handledIds.add(a.id);
    const who = `#${a.id} ${maskAcct(a)}`;
    try {
      await refreshAccount(a.id);
      const fresh = await getAccount(a.id);
      if (isPaid(fresh) && !isExpired(fresh, now)) {
        // Recovered: clear error, verify, restore schedulable, prove with /test.
        await clearAccountError(a.id);
        const ver = verificationReport(await getAccount(a.id));
        if (fresh.schedulable === false) await setSchedulable({ id: a.id, schedulable: true });
        const test = await testAccount(a.id).catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 160) }));
        const rec = baseIndex.get(accountEmail(fresh));
        let base = "no_base_record";
        if (rec) {
          baseUpdate(rec, { sub2api_status: "active", last_reauth_time: nowLocal() },
            `silent refresh recovery: plan=${planOf(fresh)}, sub_exp=${(fresh.credentials.subscription_expires_at || "?").slice(0, 10)}, test=${test.ok ? "ok" : "FAIL"}`);
          base = "updated_active";
        }
        note("reauth_restored", { who, plan: planOf(fresh), verify: ver.has_access_token && ver.has_refresh_token, test_ok: test.ok, base });
      } else {
        // Refresh worked but the subscription is gone.
        const rec = baseIndex.get(accountEmail(fresh));
        let base = "no_base_record";
        if (rec) {
          baseUpdate(rec, { sub2api_status: "失效" },
            `subscription lost (plan=${planOf(fresh) || "free"}); queued for removal by monitor`);
          base = "updated_失效";
        }
        if (!state.removal_queue.some((q) => q.id === a.id)) {
          state.removal_queue.push({ id: a.id, email_masked: maskAcct(fresh), reason: "lost_subscription", queued_at: nowLocal() });
        }
        note("reauth_lost_subscription", { who, plan: planOf(fresh) || "free", base });
      }
    } catch (err) {
      // Silent refresh impossible -> interactive Flow C (browser) required.
      const msg = String(err.message || err).slice(0, 200);
      if (!state.needs_interactive_reauth.some((x) => x.id === a.id)) {
        state.needs_interactive_reauth.push({ id: a.id, email_masked: maskAcct(a), since: nowLocal(), last_error: mask(msg) });
      }
      note("needs_interactive_reauth", { who, error: mask(msg) });
    }
  }

  // ---- Module 1a: expired accounts + removal queue --------------------------
  const survivors = accounts.filter((a) => !handledIds.has(a.id));
  for (const a of survivors) {
    let cur = a;
    const who0 = `#${a.id} ${maskAcct(a)}`;
    // Enrich missing subscription metadata via silent refresh before judging.
    if (!a.credentials?.subscription_expires_at && planOf(a) !== "free") {
      try {
        await refreshAccount(a.id);
        cur = await getAccount(a.id);
      } catch (err) {
        report.errors.push({ who: who0, stage: "enrich", error: mask(String(err.message || err).slice(0, 160)) });
        continue;
      }
    }
    if (!isExpired(cur, now)) continue;
    const who = `#${cur.id} ${maskAcct(cur)}`;
    const subExp = cur.credentials?.subscription_expires_at || "unknown";
    if (DRY_RUN) {
      note("expired_removed", { who, plan: planOf(cur), sub_exp: subExp, dry_run: true });
      continue;
    }
    try {
      await deleteAccount(cur.id);
      let gone = false;
      try { await getAccount(cur.id); } catch (e) { gone = e.status === 404; }
      const rec = baseIndex.get(accountEmail(cur));
      let base = "no_base_record";
      if (rec) {
        baseUpdate(rec, { sub2api_status: "过期" },
          `expired (plan=${planOf(cur) || "free"}, sub_exp=${String(subExp).slice(0, 10)}); removed from sub2api by monitor`);
        base = "updated_过期";
      }
      note("expired_removed", { who, plan: planOf(cur), sub_exp: subExp, deleted: gone, base });
    } catch (err) {
      report.errors.push({ who, stage: "delete_expired", error: mask(String(err.message || err).slice(0, 200)) });
    }
  }

  // Removal queue (from module 1b of this or earlier runs).
  const liveIds = new Set(accounts.map((a) => a.id));
  const stillQueued = [];
  for (const q of state.removal_queue || []) {
    if (!liveIds.has(q.id)) continue; // already gone
    const who = `#${q.id} ${q.email_masked}`;
    if (DRY_RUN) { note("removed_from_queue", { who, reason: q.reason, dry_run: true }); stillQueued.push(q); continue; }
    try {
      await deleteAccount(q.id);
      let gone = false;
      try { await getAccount(q.id); } catch (e) { gone = e.status === 404; }
      note("removed_from_queue", { who, reason: q.reason, deleted: gone });
    } catch (err) {
      report.errors.push({ who, stage: "delete_queued", error: mask(String(err.message || err).slice(0, 200)) });
      stillQueued.push(q);
    }
  }
  state.removal_queue = stillQueued;

  // ---- Module 1c: config verification (report-only) -------------------------
  // Canonical model mapping = key set of the largest healthy mapping observed.
  const healthyNow = accounts.filter((a) => !handledIds.has(a.id) && a.status === "active" && !isExpired(a, now));
  let canonicalKeys = null;
  for (const a of healthyNow) {
    const mm = a.credentials?.model_mapping;
    const keys = mm && typeof mm === "object" ? Object.keys(mm) : [];
    if (!canonicalKeys || keys.length > canonicalKeys.length) canonicalKeys = keys;
  }
  for (const a of healthyNow) {
    const who = `#${a.id} ${maskAcct(a)}`;
    const issues = [];
    if (a.proxy_id !== CANONICAL_PROXY_ID) issues.push(`proxy_id=${a.proxy_id} (want ${CANONICAL_PROXY_ID})`);
    const gids = a.group_ids || [];
    if (!CANONICAL_GROUP_IDS.every((g) => gids.includes(g))) issues.push(`group_ids=${JSON.stringify(gids)} (want ${JSON.stringify(CANONICAL_GROUP_IDS)})`);
    const mm = a.credentials?.model_mapping;
    const keys = mm && typeof mm === "object" ? Object.keys(mm) : [];
    if (keys.length < CANONICAL_MAPPING_SIZE) issues.push(`model_mapping=${keys.length}/${CANONICAL_MAPPING_SIZE}`);
    else if (canonicalKeys && canonicalKeys.length > keys.length) issues.push(`model_mapping missing ${canonicalKeys.length - keys.length} keys vs canonical`);
    if (a.schedulable !== true) issues.push("schedulable=false");
    if (issues.length) note("config_issues", { who, issues });
    else note("healthy", { who, plan: planOf(a), sub_days_left: Math.round(((subExpMs(a) || now) - now) / 86400000) });
  }

  // ---- Module 2: capacity (usage probes on healthy accounts) -----------------
  for (const h of report.modules.healthy) {
    const id = Number(h.who.split(" ")[0].slice(1));
    const a = accounts.find((x) => x.id === id);
    if (!a) continue;
    let u5 = a.extra?.codex_5h_used_percent, u7 = a.extra?.codex_7d_used_percent;
    let r5 = a.extra?.codex_5h_reset_at, r7 = a.extra?.codex_7d_reset_at;
    const upd = parseTime(a.extra?.codex_usage_updated_at);
    const stale = !upd || now - upd > USAGE_FRESH_MS;
    if (stale && !SKIP_USAGE_PROBE && !DRY_RUN) {
      try {
        const u = await getAccountUsage(id, { source: "active", force: true });
        if (u?.five_hour) { u5 = u.five_hour.utilization; r5 = u.five_hour.resets_at; }
        if (u?.seven_day) { u7 = u.seven_day.utilization; r7 = u.seven_day.resets_at; }
      } catch (err) {
        report.errors.push({ who: h.who, stage: "usage_probe", error: mask(String(err.message || err).slice(0, 160)) });
      }
    }
    const avail5 = u5 == null ? null : Math.max(0, 100 - Number(u5));
    const avail7 = u7 == null ? null : Math.max(0, 100 - Number(u7));
    const avail = [avail5, avail7].filter((x) => x != null);
    const worst = avail.length ? Math.min(...avail) : null;
    h.usage = { avail_5h_pct: avail5, avail_7d_pct: avail7, reset_5h: r5 || null, reset_7d: r7 || null, stale };
    if (worst != null && worst < MIN_AVAILABLE) {
      note("capacity_alerts", { who: h.who, available_pct_worst: worst, avail_5h_pct: avail5, avail_7d_pct: avail7, reset_5h: r5 || null, reset_7d: r7 || null });
    }
  }

  // ---- finalize ---------------------------------------------------------------
  state.last_run = { at: report.run_at, dry_run: DRY_RUN, accounts_seen: accounts.length };
  // Drop entries for accounts that no longer exist OR left the error state
  // (e.g. recovered via manual Flow C reauth between monitor runs).
  const errorIds = new Set(errorAccounts.map((a) => a.id));
  state.needs_interactive_reauth = (state.needs_interactive_reauth || []).filter((x) => liveIds.has(x.id) && errorIds.has(x.id));
  saveState(state);
  const attention = ["expired_removed", "reauth_lost_subscription", "needs_interactive_reauth", "config_issues", "capacity_alerts"]
    .some((k) => report.modules[k].length > 0) || report.errors.length > 0 || report.modules.removed_from_queue.length > 0;
  report.needs_attention = attention;
  report.fleet = {
    total: accounts.length,
    healthy: report.modules.healthy.length,
    error_state: errorAccounts.length,
    expired_removed: report.modules.expired_removed.length,
    removal_queue_remaining: state.removal_queue.length,
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), { mode: 0o600 });

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report));
    return;
  }
  const M = report.modules;
  const line = (k, fmt) => (M[k].length ? M[k].map((x) => `  - ${fmt(x)}`).join("\n") : "  (none)");
  console.log(`sub2api monitor — ${report.run_at}${DRY_RUN ? " [DRY RUN]" : ""}`);
  console.log(`fleet: total=${report.fleet.total} healthy=${report.fleet.healthy} error=${report.fleet.error_state} expired_removed=${report.fleet.expired_removed} queue_left=${report.fleet.removal_queue_remaining}`);
  console.log(`\n[1a] expired removed:\n${line("expired_removed", (x) => `${x.who} plan=${x.plan} sub_exp=${String(x.sub_exp).slice(0, 10)} base=${x.base}${x.dry_run ? " (dry)" : ""}`)}`);
  console.log(`[1a] removal queue processed:\n${line("removed_from_queue", (x) => `${x.who} reason=${x.reason}${x.dry_run ? " (dry)" : ""}`)}`);
  console.log(`[1b] restored via silent refresh:\n${line("reauth_restored", (x) => `${x.who} plan=${x.plan} test=${x.test_ok ? "ok" : "FAIL"} base=${x.base}`)}`);
  console.log(`[1b] lost subscription -> 失效 + queue:\n${line("reauth_lost_subscription", (x) => `${x.who} plan=${x.plan} base=${x.base}`)}`);
  console.log(`[1b] needs interactive reauth (Flow C):\n${line("needs_interactive_reauth", (x) => `${x.who}: ${String(x.error).slice(0, 120)}`)}`);
  console.log(`[1c] config issues:\n${line("config_issues", (x) => `${x.who}: ${x.issues.join("; ")}`)}`);
  console.log(`[2] capacity alerts (available < ${MIN_AVAILABLE}%):\n${line("capacity_alerts", (x) => `${x.who} worst_avail=${x.available_pct_worst}% (5h=${x.avail_5h_pct}% 7d=${x.avail_7d_pct}%, 7d_reset=${String(x.reset_7d || "?").slice(0, 16)})`)}`);
  if (report.errors.length) console.log(`\nerrors:\n${report.errors.map((e) => `  - ${e.who} [${e.stage}] ${e.error}`).join("\n")}`);
  console.log(`\nNEEDS_ATTENTION=${attention}`);
}

main().catch((err) => {
  console.error(`monitor fatal: ${mask(String(err.stack || err.message || err))}`);
  process.exit(1);
});
