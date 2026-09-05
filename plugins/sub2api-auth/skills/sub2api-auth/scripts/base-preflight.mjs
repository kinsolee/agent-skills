#!/usr/bin/env node
// base-preflight.mjs — ensure the configured Feishu Base tables match the canonical schema in
// feishu-base.mjs. Non-destructive by default: auto-CREATES missing fields (incl. style + select
// options). Type mismatches and unexpected extra fields are REPORTED only — fixing a type needs
// delete+recreate (column data loss) and extra fields may be intentional user data, so neither is
// touched without --force (--force still never deletes extra fields). Run before batch/heartbeat
// runs and whenever the Base may have been hand-edited.
//   Usage: node base-preflight.mjs [--force] [--quiet]
//   Exit 0 = consistent (or made consistent via creates); non-zero = unresolved mismatch / Base missing.
import { execFileSync } from "node:child_process";
import { resolveBase, SCHEMA, fieldCreateBody, TABLE_NAMES } from "./feishu-base.mjs";

const FORCE = process.argv.includes("--force");
const QUIET = process.argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.warn(...a);

function runLark(args) {
  return JSON.parse(execFileSync("lark-cli", args, { encoding: "utf8" }));
}
function fieldList(baseToken, tableId) {
  return runLark(["base", "+field-list", "--base-token", baseToken, "--table-id", tableId, "--as", "user"]).data.fields;
}
function createField(baseToken, tableId, entry) {
  const out = runLark(["base", "+field-create", "--base-token", baseToken, "--table-id", tableId, "--json", JSON.stringify(fieldCreateBody(entry)), "--as", "user"]);
  if (!out?.ok) throw new Error(`field-create failed for "${entry.name}": ${JSON.stringify(out).slice(0, 200)}`);
}
function deleteField(baseToken, tableId, field) {
  const out = runLark(["base", "+field-delete", "--base-token", baseToken, "--table-id", tableId, "--field-id", field.id || field.name, "--yes", "--as", "user"]);
  if (!out?.ok) throw new Error(`field-delete failed for "${field.name}": ${JSON.stringify(out).slice(0, 200)}`);
}

let { baseToken, gptAccountsTableId, simCardsTableId } = (() => { try { return resolveBase(); } catch (e) { warn("preflight: " + e.message); process.exit(1); } })();
const tables = [
  { name: TABLE_NAMES.gpt, id: gptAccountsTableId },
  { name: TABLE_NAMES.sim, id: simCardsTableId },
];

let problems = 0;
for (const t of tables) {
  let live = fieldList(baseToken, t.id);
  const schema = SCHEMA[t.name];
  const schemaNames = new Set(schema.map((s) => s.name));

  // 1) missing -> create (non-destructive)
  const created = [];
  for (const entry of schema) {
    if (!live.some((f) => f.name === entry.name)) {
      createField(baseToken, t.id, entry);
      created.push(entry.name);
    }
  }
  if (created.length) live = fieldList(baseToken, t.id); // re-fetch after creates
  const liveByName = new Map(live.map((f) => [f.name, f]));

  // 2) type mismatches
  const typeMismatch = schema.filter((s) => liveByName.has(s.name) && liveByName.get(s.name).type !== s.type);
  for (const s of typeMismatch) {
    const lf = liveByName.get(s.name);
    if (FORCE) {
      warn(`  --force: delete+recreate "${s.name}" (live=${lf.type} -> schema=${s.type}) — COLUMN DATA LOST`);
      deleteField(baseToken, t.id, lf);
      createField(baseToken, t.id, s);
    } else {
      warn(`  TYPE MISMATCH "${s.name}": live=${lf.type} want=${s.type} (re-run with --force to delete+recreate; loses column data)`);
      problems++;
    }
  }

  // 3) extra fields (in Base, not in schema) — never auto-deleted
  const extra = live.map((f) => f.name).filter((n) => !schemaNames.has(n));
  for (const n of extra) warn(`  EXTRA field "${n}" present (not in schema) — left as-is; remove manually if unintended`);

  log(`${t.name}: ${live.length} fields${created.length ? ` (created ${created.length}: ${created.join(", ")})` : ""}${extra.length ? ` (${extra.length} extra)` : ""}`);
}

if (problems === 0) {
  log("preflight: consistent");
  process.exit(0);
} else {
  warn(`preflight: ${problems} unresolved mismatch(es)`);
  process.exit(1);
}
