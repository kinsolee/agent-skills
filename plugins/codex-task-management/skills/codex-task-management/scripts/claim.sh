#!/usr/bin/env bash
# 接单门禁：todo 才能接、依赖全 done、WIP 2+2、绑定当前对话后转 in_progress。
# 用法：claim.sh <ISSUE_ID>
set -euo pipefail

ISSUE_ID="${1:?用法：claim.sh <ISSUE_ID>}"
TASKCTL="${TASKCTL:-/opt/homebrew/bin/taskctl}"
JQ="${JQ:-/usr/bin/jq}"
THREAD_ID="${CODEX_THREAD_ID:-}"

die() { echo "claim 失败：$*" >&2; exit 1; }

if [ -z "${THREAD_ID}" ]; then die "CODEX_THREAD_ID 未注入，须在 Codex 对话内运行。"; fi

TASK_JSON="$("${TASKCTL}" issue get "${ISSUE_ID}" --json | "${JQ}" -c '.task // empty')" || die "issue ${ISSUE_ID} 不存在。"
if [ -z "${TASK_JSON}" ]; then die "issue ${ISSUE_ID} 不存在。"; fi

STATUS="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.status')"
BOUND_THREAD="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.threadBinding.threadId // empty')"

if [ -n "${BOUND_THREAD}" ] && [ "${BOUND_THREAD}" = "${THREAD_ID}" ]; then
  WORKSPACE="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.threadBinding.workspacePath // empty')"
  RECEIPT="$(printf '接单回执（同线程重入补写）\n- thread：%s\n- workspace：%s' "${THREAD_ID}" "${WORKSPACE}")"
  if ! "${TASKCTL}" comment add "${ISSUE_ID}" --body "${RECEIPT}" --thread-id "${THREAD_ID}" >/dev/null; then
    die "回执写入失败，请手工补 comment。"
  fi
  echo "已接单（同线程重入）：${ISSUE_ID}（thread=${THREAD_ID}）"
  exit 0
fi
if [ -n "${BOUND_THREAD}" ]; then die "已被其他对话绑定（thread=${BOUND_THREAD}）。重派工需先清理旧绑定，旧回执随之失效。"; fi
if [ "${STATUS}" != "todo" ]; then die "状态为 ${STATUS}，只有 todo 可接单。"; fi

BLOCKED_IDS="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.relations.blockedBy[]? | if type=="object" then (.id // .identifier) else . end')"
for BID in ${BLOCKED_IDS}; do
  if [ "${BID}" = "null" ] || [ -z "${BID}" ]; then continue; fi
  BST="$("${TASKCTL}" issue get "${BID}" --json | "${JQ}" -r '.task.status')"
  if [ "${BST}" != "done" ]; then die "依赖 ${BID} 状态为 ${BST}，须先完成。"; fi
done

PROJECT_ID="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.projectId')"

# 项目级串行锁：包住 WIP 统计与 move，消除"统计通过但落状态前被并发抢占"的窗口
LOCK="/tmp/taskboard-claim-${PROJECT_ID}.lock"
ACQUIRED=""
for _ in $(seq 1 120); do
  if mkdir "${LOCK}" 2>/dev/null; then ACQUIRED=1; break; fi
  sleep 0.5
done
if [ -z "${ACQUIRED}" ]; then die "项目接单锁等待超时（${LOCK}），请重试。"; fi
trap 'rmdir "${LOCK}" 2>/dev/null || true' EXIT

wip_count() { "${TASKCTL}" issue list --project "${1}" --status "${2}" --json | "${JQ}" '.tasks | length'; }
N_PRG="$(wip_count "${PROJECT_ID}" in_progress)"
if [ "${N_PRG}" -ge 2 ]; then die "项目 ${PROJECT_ID} 已有 ${N_PRG} 个 in_progress（上限 2）。"; fi
N_REV="$(wip_count "${PROJECT_ID}" in_review)"
if [ "${N_REV}" -ge 2 ]; then die "项目 ${PROJECT_ID} 已有 ${N_REV} 个 in_review（上限 2）。"; fi

WORKSPACE="$("${TASKCTL}" project list --json | "${JQ}" -r --arg p "${PROJECT_ID}" '.projects[] | select(.id == $p) | .workspacePath // empty')"
if [ -z "${WORKSPACE}" ]; then die "project ${PROJECT_ID} 未映射 workspacePath，先执行 project map。"; fi

VERSION="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.version')"
if ! "${TASKCTL}" issue move "${ISSUE_ID}" --status in_progress --thread-id "${THREAD_ID}" \
    --binding-thread-id "${THREAD_ID}" \
    --binding-codex-project-id "${PROJECT_ID}" \
    --binding-codex-project-kind local \
    --binding-codex-host-id local \
    --binding-workspace-path "${WORKSPACE}" \
    --if-version "${VERSION}" --json >/dev/null; then
  die "move 失败：状态或版本已变化（并发抢单或旧快照），请重跑 claim.sh。"
fi

RECEIPT="$(printf '接单回执\n- thread：%s\n- workspace：%s\n- 下一步：建独立 worktree 与分支，bootstrap 项目规则后开工；交付时转 in_review。' "${THREAD_ID}" "${WORKSPACE}")"
if ! "${TASKCTL}" comment add "${ISSUE_ID}" --body "${RECEIPT}" --thread-id "${THREAD_ID}" >/dev/null; then
  die "已转 in_progress，但接单回执写入失败，请手工补 comment。"
fi

echo "已接单：${ISSUE_ID} → in_progress（thread=${THREAD_ID}，workspace=${WORKSPACE}）"
