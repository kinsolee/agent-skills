// feishu-base.mjs — shared Feishu Base resolver + canonical schema (source of truth).
// No hardcoded identifiers: base_token and table ids resolve dynamically via lark-cli
// (title-resolve "sub2api-auth" + table-list by name), with optional FEISHU_* env overrides.
// SCHEMA is the canonical field definition for both tables; flow scripts use resolveBase()
// and base-preflight.mjs uses SCHEMA + tableFields() + fieldCreateBody().
// Verified 2026-08-13 against the live Base (all 28 fields, types, styles, select options).
import { execFileSync } from "node:child_process";

const BASE_TITLE = "sub2api-auth";
const GPT_TABLE_NAME = "gpt_accounts";
const SIM_TABLE_NAME = "sim_cards";

const DT = { format: "yyyy-MM-dd HH:mm" };
const opt = (name, hue, lightness = "Lighter") => ({ name, hue, lightness });

// Canonical field definitions. `url`/`email` are text + style (not separate types).
// Select options carry their colors so recreation is faithful.
export const SCHEMA = {
  [GPT_TABLE_NAME]: [
    { name: "email", type: "text", style: { type: "email" } },
    { name: "password", type: "text" },
    { name: "mfa_secret", type: "text" },
    { name: "mfa_platform_url", type: "text", style: { type: "url" } },
    { name: "email_helper_url", type: "text", style: { type: "url" } },
    { name: "source_order", type: "text" },
    { name: "source_provider", type: "text" },
    { name: "bound_phone", type: "text" },
    { name: "notes", type: "text" },
    { name: "auth_time", type: "datetime", style: DT },
    { name: "last_reauth_time", type: "datetime", style: DT },
    { name: "waiting_since", type: "datetime", style: DT },
    { name: "sub2api_status", type: "select", multiple: false, options: [
      opt("pending", "Red"), opt("authorizing", "Blue"), opt("active", "Turquoise"),
      opt("waiting_sim", "Orange"), opt("revoked", "Orange"), opt("banned", "Green"),
      opt("failed", "Red"), opt("manual_required", "Purple"), opt("deactivated", "Blue"),
      opt("过期", "Lime"), opt("失效", "Gray"), opt("error", "Yellow"), opt("done", "Wathet"),
    ] },
    { name: "mfa_platform_type", type: "select", multiple: false, options: [
      opt("网页", "Orange"), opt("API", "Yellow"), opt("unknown", "Wathet"),
    ] },
  ],
  [SIM_TABLE_NAME]: [
    { name: "phone_number", type: "text" },
    { name: "sms_url", type: "text", style: { type: "url" } },
    { name: "redeem_code", type: "text" },
    { name: "redeem_url", type: "text" },
    { name: "bound_accounts", type: "text" },
    { name: "source_order", type: "text" },
    { name: "notes", type: "text" },
    { name: "last_bind_time", type: "datetime", style: DT },
    { name: "valid_until", type: "datetime", style: DT },
    { name: "cooldown_until", type: "datetime", style: DT },
    { name: "bind_count", type: "number", style: { percentage: false, precision: 0, thousands_separator: false, type: "plain" } },
    { name: "channel", type: "select", multiple: false, options: [
      opt("direct", "Carmine"), opt("chongpt", "Carmine"),
    ] },
    { name: "sms_type", type: "select", multiple: false, options: [
      opt("网页", "Orange"), opt("API", "Yellow"), opt("unknown", "Wathet"),
    ] },
    { name: "status", type: "select", multiple: false, options: [
      opt("available", "Yellow"), opt("cooldown", "Lime"), opt("expired", "Purple"),
      opt("exhausted", "Yellow"), opt("unavailable", "Lime"),
    ] },
  ],
};

function runLark(args) {
  return execFileSync("lark-cli", args, { encoding: "utf8" });
}

let cache = null;

// Resolve base_token + both table ids. Sync (matches the flow scripts' sync style).
// Optional env overrides: FEISHU_BASE_APP_TOKEN, FEISHU_TABLE_GPT_ACCOUNTS, FEISHU_TABLE_SIM_CARDS.
export function resolveBase() {
  if (cache) return cache;
  let baseToken = process.env.FEISHU_BASE_APP_TOKEN;
  if (!baseToken) {
    const j = JSON.parse(runLark(["base", "+title-resolve", "--title", BASE_TITLE, "--as", "user"]));
    baseToken = j?.data?.base_token;
    if (!baseToken) throw new Error(`could not resolve Feishu Base "${BASE_TITLE}" via lark-cli title-resolve (set FEISHU_BASE_APP_TOKEN to override)`);
  }
  const tables = JSON.parse(runLark(["base", "+table-list", "--base-token", baseToken, "--as", "user"])).data.tables;
  const byName = (n) => (tables.find((t) => t.name === n) || {}).id;
  const gptAccountsTableId = process.env.FEISHU_TABLE_GPT_ACCOUNTS || byName(GPT_TABLE_NAME);
  const simCardsTableId = process.env.FEISHU_TABLE_SIM_CARDS || byName(SIM_TABLE_NAME);
  if (!gptAccountsTableId || !simCardsTableId) {
    throw new Error(`could not find tables "${GPT_TABLE_NAME}"/"${SIM_TABLE_NAME}" in Base "${BASE_TITLE}" (got gpt=${gptAccountsTableId || "?"}, sim=${simCardsTableId || "?"})`);
  }
  cache = { baseToken, gptAccountsTableId, simCardsTableId };
  return cache;
}

// Current fields of a table, normalized to { name, type, style, multiple, options? }.
export function tableFields(baseToken, tableId) {
  const j = JSON.parse(runLark(["base", "+field-list", "--base-token", baseToken, "--table-id", tableId, "--as", "user"]));
  return (j?.data?.fields || []).map((f) => ({
    name: f.name,
    type: f.type,
    style: f.style,
    multiple: f.multiple,
    options: Array.isArray(f.options) ? f.options.map((o) => ({ name: o.name, hue: o.hue, lightness: o.lightness })) : undefined,
  }));
}

// Build a +field-create JSON body from a SCHEMA entry (faithful recreate).
export function fieldCreateBody(entry) {
  const body = { name: entry.name, type: entry.type };
  if (entry.style) body.style = entry.style;
  if (entry.type === "select") {
    body.multiple = entry.multiple ?? false;
    if (entry.options) body.options = entry.options;
  }
  return body;
}

export const TABLE_NAMES = { gpt: GPT_TABLE_NAME, sim: SIM_TABLE_NAME };
