import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const claim = path.join(root, "plugins/codex-task-management/skills/codex-task-management/scripts/claim.sh");

test("claim.sh gate creates and records a worktree, reentry reuses it, foreign binding is rejected", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "claim-gate-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const ws = path.join(temp, "demo-erp");
  mkdirSync(ws);
  const git = (...args) => {
    const r = spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-b", "main");
  writeFileSync(path.join(ws, "README.md"), "demo\n");
  git("add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init");

  const log = path.join(temp, "taskctl.log");
  const fixture = path.join(temp, "issue.json");
  const stub = path.join(temp, "taskctl-stub.sh");
  const stubLines = [
    "#!/usr/bin/env bash",
    "LOG=" + JSON.stringify(log),
    "FIXTURE=" + JSON.stringify(fixture),
    "WS=" + JSON.stringify(ws),
    'case "$1 $2" in',
    '  "issue get") cat "${FIXTURE}"; exit 0 ;;',
    "  \"project list\") printProjects ;;",
    "esac",
  ];
  // project list needs the workspace path, so write it explicitly
  stubLines[6] = "  \"project list\") printf '{\"projects\":[{\"id\":\"p1\",\"workspacePath\":\"%s\"}]}' \"${WS}\"; exit 0 ;;";
  stubLines.push(
    "printf '%s' \"$*\" >> \"${LOG}\"",
    'case "$1 $2" in',
    "  \"issue list\") echo '{\"tasks\":[]}' ;;",
    "  *) echo '{}' ;;",
    "esac",
  );
  writeFileSync(stub, stubLines.join("\n") + "\n");
  chmodSync(stub, 0o755);

  const task = {
    status: "todo",
    version: 7,
    projectId: "p1",
    title: "mercado 对接：og:image B 侧证据 + 闸门接线",
    threadBinding: { threadId: null, workspacePath: null },
    relations: { blockedBy: [] },
    developmentContext: null,
  };
  const writeFixture = (threadId, status) => {
    writeFileSync(fixture, JSON.stringify({ task: { ...task, status, threadBinding: { threadId, workspacePath: ws } } }));
  };
  const claimRun = (thread) => spawnSync("bash", [claim, "TKS-9"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_THREAD_ID: thread, TASKCTL: stub, JQ: "/usr/bin/jq" },
  });

  const wt = ws + "-tks-9";
  const branch = "codex/tks-9-mercado-og-image-b";
  const branchOf = (dir) => spawnSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();

  writeFixture(null, "todo");
  const first = claimRun("thread-A");
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(existsSync(wt), true, "worktree should exist at " + wt);
  assert.equal(branchOf(wt), branch);
  const logged = readFileSync(log, "utf8");
  assert.ok(logged.includes("--worktree-path " + wt), logged);
  assert.ok(logged.includes("--worktree-branch " + branch), logged);

  writeFixture("thread-A", "in_progress");
  const again = claimRun("thread-A");
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(branchOf(wt), branch);

  writeFixture("thread-B", "in_progress");
  const foreign = claimRun("thread-A");
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /已被其他对话绑定/);
  assert.equal(branchOf(wt), branch);
});
