// sub2api-reauth-runner.mjs — hourly reauth automation (launchd: com.kinso.sub2api-reauth).
//
// Pipeline:
//   1. Run src/sub2api-monitor.mjs (silent admin-API refresh recovery + queue flagging).
//   2. Read state/monitor-state.json -> needs_interactive_reauth.
//   3. If non-empty: spawn a headless `codex exec` agent to run the sub2api-auth
//      skill Flow C (browser reauth) for the queued accounts. Attempt-tracked:
//      an account still failing after MAX_ATTEMPTS hourly attempts is parked.
//   4. Re-run the monitor to reconcile the queue.
//
// Unattended by design: no user interaction; the agent prompt forbids handoff waits.
// Logs: state/reauth-runner.log (rotated at 2 MB). Agent message: state/reauth-agent-last-message.md.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STATE_DIR = path.join(ROOT, "state");
const LOG_FILE = path.join(STATE_DIR, "reauth-runner.log");
const LOCK_FILE = path.join(STATE_DIR, "reauth-runner.lock");
const RUNNER_STATE_FILE = path.join(STATE_DIR, "reauth-runner-state.json");
const MONITOR_STATE_FILE = path.join(STATE_DIR, "monitor-state.json");
const AGENT_MSG_FILE = path.join(STATE_DIR, "reauth-agent-last-message.md");
const MONITOR_SCRIPT = path.join(HERE, "sub2api-monitor.mjs");
const MAX_ATTEMPTS = 3;
const LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 h (agent runs are capped at 90 min)
const AGENT_TIMEOUT_MS = 90 * 60 * 1000;

const nowLocal = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function log(msg) {
  const line = `[${nowLocal()}] ${msg}\n`;
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 2 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + ".old");
  } catch {}
  appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };

// --- lock -------------------------------------------------------------------
function acquireLock() {
  const existing = readJson(LOCK_FILE, null);
  if (existing) {
    const age = Date.now() - Number(existing.started_at_ms || 0);
    let alive = false;
    try { process.kill(Number(existing.pid), 0); alive = true; } catch {}
    if (alive && age < LOCK_TTL_MS) {
      log(`lock held by pid=${existing.pid} since ${existing.started_at} — skipping this run`);
      return false;
    }
    log(`breaking stale lock (pid=${existing.pid}, alive=${alive}, age_min=${Math.round(age / 60000)})`);
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, started_at: nowLocal(), started_at_ms: Date.now() }), { mode: 0o600 });
  return true;
}
function releaseLock() { try { writeFileSync(LOCK_FILE, ""); } catch {} }

// --- monitor ----------------------------------------------------------------
function runMonitor(label) {
  log(`monitor run (${label}) start`);
  const res = spawnSync("node", [MONITOR_SCRIPT], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const out = ((res.stdout || "") + (res.stderr || "")).trim();
  for (const line of out.split("\n").slice(-12)) if (line.trim()) log(`  monitor: ${line.trim()}`);
  if (res.status !== 0) log(`monitor (${label}) exited status=${res.status}${res.signal ? ` signal=${res.signal}` : ""}`);
  return res.status === 0;
}

// --- main -------------------------------------------------------------------
if (!acquireLock()) process.exit(0);
try {
  runMonitor("preflight");
  const mstate = readJson(MONITOR_STATE_FILE, { needs_interactive_reauth: [] });
  const queue = mstate.needs_interactive_reauth || [];
  const rstate = readJson(RUNNER_STATE_FILE, { attempts: {}, parked: [] });
  rstate.attempts = rstate.attempts || {};
  rstate.parked = rstate.parked || [];

  // Reconcile: accounts that left the queue are recovered — clear their attempt history.
  const queuedIds = new Set(queue.map((q) => q.id));
  for (const id of Object.keys(rstate.attempts)) if (!queuedIds.has(Number(id))) delete rstate.attempts[id];
  rstate.parked = rstate.parked.filter((p) => queuedIds.has(p.id));

  if (queue.length === 0) {
    log("no accounts need interactive reauth — done");
    writeFileSync(RUNNER_STATE_FILE, JSON.stringify(rstate, null, 2), { mode: 0o600 });
    process.exit(0);
  }

  const eligible = queue.filter((q) => (rstate.attempts[q.id]?.count || 0) < MAX_ATTEMPTS && !rstate.parked.some((p) => p.id === q.id));
  const parkedNow = queue.filter((q) => !eligible.includes(q));
  for (const p of parkedNow) log(`#${p.id} ${p.email_masked} parked after ${rstate.attempts[p.id]?.count ?? MAX_ATTEMPTS} failed attempts — needs human attention`);
  if (eligible.length === 0) {
    log("all queued accounts parked — no agent run");
    writeFileSync(RUNNER_STATE_FILE, JSON.stringify(rstate, null, 2), { mode: 0o600 });
    process.exit(0);
  }

  const accountList = eligible.map((q) => `#${q.id} (${q.email_masked})`).join(", ");
  const prompt = [
    `使用 sub2api-auth skill 的 Flow C（重新授权）对以下 sub2api 错误状态账号执行浏览器交互式重新授权（静默 refresh 已确认失败）：${accountList}。`,
    "要求：",
    "1. 严格遵循该 skill 的 Flow C、全部 Hard Rules 以及 references/known-ui-patterns.md（每账号独立 ego-browser task space 并在完成后 completeTaskSpace；OAuth 身份硬门槛；apply 后修复 model_mapping 并恢复 schedulable=true；SSE test 必须以 test_complete success=true 结束；Feishu Base 更新 sub2api_status=active + last_reauth_time 并回读确认）。",
    "2. 本次为无人值守定时任务，没有可交互的用户：遇到 CAPTCHA、滑块或未知页面时按 skill 的 Error Recovery 表自动处理；若自动手段用尽，将该账号的 Base 记录标记 sub2api_status=manual_required 并在 notes 追加掩码诊断，然后跳过该账号继续下一个。禁止 handOffTaskSpace 后等待用户。",
    "3. 凭据、auth URL、callback URL、验证码等敏感内容一律不得出现在任何输出中（Hard Rules 4/10/22）。",
    "4. 全部完成后，输出每个账号的最终状态摘要（掩码邮箱 + active/manual_required/failed + 关键证据）。",
  ].join("\n");

  log(`spawning codex exec agent for ${eligible.length} account(s): ${accountList}`);
  const started = Date.now();
  const agent = spawnSync("codex", [
    "exec",
    "-C", ROOT,
    "-s", "danger-full-access",
    "-c", "approval_policy=\"never\"",
    "-o", AGENT_MSG_FILE,
    prompt,
  ], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: AGENT_TIMEOUT_MS });
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  log(`agent exited status=${agent.status}${agent.signal ? ` signal=${agent.signal}` : ""} after ${mins} min`);
  const tail = ((agent.stdout || "") + (agent.stderr || "")).trim().split("\n").slice(-8);
  for (const line of tail) if (line.trim()) log(`  agent: ${line.trim().slice(0, 300)}`);

  // Attempt accounting for accounts still queued after the agent run.
  runMonitor("post-agent reconcile");
  const after = readJson(MONITOR_STATE_FILE, { needs_interactive_reauth: [] });
  const stillQueued = new Set((after.needs_interactive_reauth || []).map((q) => q.id));
  for (const q of eligible) {
    if (stillQueued.has(q.id)) {
      const a = rstate.attempts[q.id] || { count: 0 };
      a.count += 1;
      a.last_at = nowLocal();
      a.last_exit = agent.status;
      rstate.attempts[q.id] = a;
      log(`#${q.id} still in error after agent attempt ${a.count}/${MAX_ATTEMPTS}`);
      if (a.count >= MAX_ATTEMPTS && !rstate.parked.some((p) => p.id === q.id)) rstate.parked.push({ id: q.id, email_masked: q.email_masked, parked_at: nowLocal() });
    } else {
      log(`#${q.id} recovered — cleared from reauth queue`);
    }
  }
  writeFileSync(RUNNER_STATE_FILE, JSON.stringify(rstate, null, 2), { mode: 0o600 });
  log("run complete");
} catch (err) {
  log(`runner fatal: ${String(err.stack || err.message || err).slice(0, 500)}`);
  process.exitCode = 1;
} finally {
  releaseLock();
}
