#!/usr/bin/env bash
# 接单门禁：todo 才能接、依赖全 done、WIP 2+2、绑定当前对话后转 in_progress。
# 校验通过后自动创建独立 worktree 与分支（codex/<issue>-<标题slug>），并把
# developmentContext（worktree path/branch）写回 issue，杜绝"接单后直接在主工作区
# 改代码"的并行冲突。首次接单的状态变更与 worktree 创建全程持项目串行锁；
# 同线程重入路径不持锁（绑定校验已排除其他线程，record 幂等）。
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

REENTRY=0
if [ -n "${BOUND_THREAD}" ]; then
  if [ "${BOUND_THREAD}" = "${THREAD_ID}" ]; then
    REENTRY=1
  else
    die "已被其他对话绑定（thread=${BOUND_THREAD}）。重派工需先清理旧绑定，旧回执随之失效。"
  fi
fi
if [ "${REENTRY}" -eq 0 ] && [ "${STATUS}" != "todo" ]; then die "状态为 ${STATUS}，只有 todo 可接单。"; fi

VERSION="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.version')"

# ensure_worktree <主工作区>：确定并复用/创建 WT_PATH 与 BRANCH（全局输出）。
ensure_worktree() {
  local WS="$1"
  git -C "${WS}" rev-parse --git-dir >/dev/null 2>&1 || die "${WS} 不是 git 仓库。"
  local BASE
  if git -C "${WS}" show-ref --verify --quiet refs/heads/main; then BASE=main; else BASE=master; fi
  local ID_LC SLUG
  ID_LC="$(printf '%s' "${ISSUE_ID}" | tr '[:upper:]' '[:lower:]')"
  SLUG="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.title // empty' \
    | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-30 | sed -E 's/-+$//')"
  if [ -n "${SLUG}" ]; then BRANCH="codex/${ID_LC}-${SLUG}"; else BRANCH="codex/${ID_LC}"; fi
  WT_PATH="$(dirname "${WS}")/$(basename "${WS}")-${ID_LC}"
  if [ -e "${WT_PATH}" ]; then
    local COMMON_WT COMMON_WS WT_BRANCH
    COMMON_WT="$(git -C "${WT_PATH}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
      || die "${WT_PATH} 已存在但不是 git 工作树，需人工处理。"
    COMMON_WS="$(git -C "${WS}" rev-parse --path-format=absolute --git-common-dir)"
    [ "${COMMON_WT}" = "${COMMON_WS}" ] || die "${WT_PATH} 属于其他仓库（${COMMON_WT}），拒绝复用。"
    WT_BRANCH="$(git -C "${WT_PATH}" symbolic-ref --short HEAD 2>/dev/null || true)"
    [ "${WT_BRANCH}" = "${BRANCH}" ] \
      || die "${WT_PATH} 当前分支为 ${WT_BRANCH:-detach}，与预期 ${BRANCH} 不一致，需人工处理。"
    return 0
  fi
  if git -C "${WS}" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git -C "${WS}" worktree add "${WT_PATH}" "${BRANCH}" >/dev/null \
      || die "复用已有分支 ${BRANCH} 创建 worktree 失败：${WT_PATH}。"
  else
    git -C "${WS}" worktree add -b "${BRANCH}" "${WT_PATH}" "${BASE}" >/dev/null \
      || die "创建 worktree 失败：${WT_PATH}（分支 ${BRANCH}，基线 ${BASE}）。"
  fi
}

record_worktree() {
  "${TASKCTL}" issue update "${ISSUE_ID}" --worktree-path "${WT_PATH}" --worktree-branch "${BRANCH}" --json >/dev/null \
    || die "worktree 已创建（${WT_PATH}，分支 ${BRANCH}），但写回 issue 失败；请手工执行 issue update --worktree-path 后重跑。"
}

comment_receipt() {
  local HEADLINE="$1" RECEIPT
  RECEIPT="$(printf '%s\n- thread：%s\n- workspace：%s\n- worktree：%s\n- 分支：%s\n- 下一步：只在 worktree 内改代码（git -C 或 cd），主工作区保持主分支；交付时转 in_review。' \
    "${HEADLINE}" "${THREAD_ID}" "${WORKSPACE}" "${WT_PATH}" "${BRANCH}")"
  "${TASKCTL}" comment add "${ISSUE_ID}" --body "${RECEIPT}" --thread-id "${THREAD_ID}" >/dev/null \
    || die "回执写入失败，请手工补 comment。"
}

if [ "${REENTRY}" -eq 1 ]; then
  WORKSPACE="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.threadBinding.workspacePath // empty')"
  [ -n "${WORKSPACE}" ] || die "同线程重入但绑定缺少 workspacePath。"
  ensure_worktree "${WORKSPACE}"
  record_worktree
  comment_receipt "接单回执（同线程重入补写）"
  echo "已接单（同线程重入）：${ISSUE_ID}（thread=${THREAD_ID}，worktree=${WT_PATH}）"
  exit 0
fi

BLOCKED_IDS="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.relations.blockedBy[]? | if type=="object" then (.id // .identifier) else . end')"
for BID in ${BLOCKED_IDS}; do
  if [ "${BID}" = "null" ] || [ -z "${BID}" ]; then continue; fi
  BST="$("${TASKCTL}" issue get "${BID}" --json | "${JQ}" -r '.task.status')"
  if [ "${BST}" != "done" ]; then die "依赖 ${BID} 状态为 ${BST}，须先完成。"; fi
done

PROJECT_ID="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.projectId')"

# 项目级串行锁：包住 WIP 统计、worktree 创建与状态/记录写入，消除并发抢单窗口
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

ensure_worktree "${WORKSPACE}"

if ! "${TASKCTL}" issue move "${ISSUE_ID}" --status in_progress --thread-id "${THREAD_ID}" \
    --binding-thread-id "${THREAD_ID}" \
    --binding-codex-project-id "${PROJECT_ID}" \
    --binding-codex-project-kind local \
    --binding-codex-host-id local \
    --binding-workspace-path "${WORKSPACE}" \
    --if-version "${VERSION}" --json >/dev/null; then
  die "move 失败：状态或版本已变化（并发抢单或旧快照），请重跑 claim.sh；已创建的 worktree ${WT_PATH:-} 会自动复用。"
fi

record_worktree
comment_receipt "接单回执"

echo "已接单：${ISSUE_ID} → in_progress（thread=${THREAD_ID}，worktree=${WT_PATH}，分支=${BRANCH}）"
