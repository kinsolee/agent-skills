#!/usr/bin/env bash
# 合并门禁：in_review 才能合并；rebase 后逐条执行 required_checks，全部通过才
# merge --no-ff 回主分支，写 landed 回执并转 done。全程持有主工作区合并锁。
# 用法：land.sh <ISSUE_ID> <批准说明>
# 环境变量：TASK_WORKTREE（issue 未记录 worktree 路径时必填）
set -euo pipefail

ISSUE_ID="${1:?用法：land.sh <ISSUE_ID> <批准说明>}"
APPROVAL="${2:?缺少用户批准说明：合并必须先取得用户批准，说明会写进 landed 回执。}"
TASKCTL="${TASKCTL:-/opt/homebrew/bin/taskctl}"
JQ="${JQ:-/usr/bin/jq}"
MAX_ROUNDS=2

die() { echo "land 失败：$*" >&2; exit 1; }
comment() {
  "${TASKCTL}" comment add "${ISSUE_ID}" --body "${1}" >/dev/null \
    || echo "警告：comment 写入失败" >&2
}

TASK_JSON="$("${TASKCTL}" issue get "${ISSUE_ID}" --json | "${JQ}" -c '.task // empty')" || die "issue ${ISSUE_ID} 不存在。"
if [ -z "${TASK_JSON}" ]; then die "issue ${ISSUE_ID} 不存在。"; fi

STATUS="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.status')"
VERSION="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.version')"
if [ "${STATUS}" != "in_review" ]; then die "状态为 ${STATUS}，只有 in_review 可合并。"; fi

WORKTREE="${TASK_WORKTREE:-$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.developmentContext.path // empty')}"
if [ -z "${WORKTREE}" ]; then die "未记录 worktree 路径（developmentContext.path）；用 TASK_WORKTREE=<绝对路径> 重跑。"; fi
if ! git -C "${WORKTREE}" rev-parse --git-dir >/dev/null 2>&1; then die "${WORKTREE} 不是 git 工作树。"; fi
if [ -n "$(git -C "${WORKTREE}" status --porcelain)" ]; then die "worktree 有未提交改动，先提交或清理。"; fi

BRANCH="$(git -C "${WORKTREE}" symbolic-ref --short HEAD)"
if [ "${BRANCH}" = "main" ] || [ "${BRANCH}" = "master" ]; then die "worktree 应在独立分支上，当前是 ${BRANCH}。"; fi
RECORDED_BRANCH="$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.developmentContext.branch // empty')"
if [ -n "${RECORDED_BRANCH}" ] && [ "${RECORDED_BRANCH}" != "${BRANCH}" ]; then
  die "worktree 实际分支为 ${BRANCH}，与 issue 记录的 ${RECORDED_BRANCH} 不一致，需人工处理。"
fi

if git -C "${WORKTREE}" show-ref --verify --quiet refs/heads/main; then BASE=main; else BASE=master; fi

MAIN_WS="${TASK_MAIN_WORKSPACE:-$(printf '%s' "${TASK_JSON}" | "${JQ}" -r '.threadBinding.workspacePath // empty')}"
if [ -z "${MAIN_WS}" ]; then die "无法确定主工作区；用 TASK_MAIN_WORKSPACE=<绝对路径> 指定。"; fi
MAIN_BRANCH="$(git -C "${MAIN_WS}" symbolic-ref --short HEAD)"
if [ "${MAIN_BRANCH}" != "${BASE}" ]; then die "主工作区 ${MAIN_WS} 在 ${MAIN_BRANCH} 分支，须停在 ${BASE} 才能合并。"; fi
if [ -n "$(git -C "${MAIN_WS}" status --porcelain)" ]; then die "主工作区有未提交改动，先提交或清理再合并。"; fi

# --path-format=absolute: main repo root prints relative ".git" without this,
# which false-positives the same-repo check against linked worktrees
COMMON_WT="$(git -C "${WORKTREE}" rev-parse --path-format=absolute --git-common-dir)"
COMMON_WS="$(git -C "${MAIN_WS}" rev-parse --path-format=absolute --git-common-dir)"
if [ "${COMMON_WT}" != "${COMMON_WS}" ]; then die "worktree 与主工作区不属于同一仓库（${COMMON_WT} 与 ${COMMON_WS}），拒绝合并。"; fi

CHECKS_FILE="$(mktemp)"
printf '%s' "${TASK_JSON}" | "${JQ}" -r '.description' \
  | awk '/^## required_checks/{f=1;next} /^## /{f=0} f && /^- /{sub(/^- /,"");print}' > "${CHECKS_FILE}"
if [ ! -s "${CHECKS_FILE}" ]; then
  rm -f "${CHECKS_FILE}"
  die "description 没有 required_checks 条目，拒绝盲目合并。"
fi

# 主工作区合并锁：串行化并发 land，避免互相 abort 对方正在进行的 merge
LOCK="/tmp/taskboard-land-$(printf '%s' "${COMMON_WS}" | tr '/' '_').lock"
ACQUIRED=""
for _ in $(seq 1 120); do
  if mkdir "${LOCK}" 2>/dev/null; then ACQUIRED=1; break; fi
  sleep 0.5
done
if [ -z "${ACQUIRED}" ]; then
  rm -f "${CHECKS_FILE}"
  die "主工作区合并锁等待超时（${LOCK}），请重试。"
fi
trap 'rmdir "${LOCK}" 2>/dev/null || true; rm -f "${CHECKS_FILE}"' EXIT

ORIG_SHA="$(git -C "${WORKTREE}" rev-parse "${BRANCH}")"
restore_branch() { git -C "${WORKTREE}" reset --hard "${ORIG_SHA}" >/dev/null 2>&1 || true; }

LANDED=0
RESULTS=""
for ROUND in $(seq 1 "${MAX_ROUNDS}"); do
  BASE_SHA="$(git -C "${WORKTREE}" rev-parse "${BASE}")"
  if ! git -C "${WORKTREE}" rebase "${BASE}" >/dev/null 2>&1; then
    git -C "${WORKTREE}" rebase --abort >/dev/null 2>&1 || true
    comment "阻塞：rebase 到 ${BASE} 失败，分支保留原状，需人工处理冲突。"
    die "rebase 冲突，已保留现场。"
  fi
  AHEAD="$(git -C "${WORKTREE}" rev-list --count "${BASE}..${BRANCH}")"
  if [ "${AHEAD}" -eq 0 ]; then
    restore_branch
    comment "合并中止：分支 ${BRANCH} 没有领先 ${BASE} 的提交（空候选），不产生合并凭证。"
    die "空候选，中止。"
  fi
  FAILED=""
  RESULTS=""
  while IFS= read -r CMD; do
    if [ -z "${CMD}" ]; then continue; fi
    echo "[${ISSUE_ID}] 运行: ${CMD}"
    if (cd "${WORKTREE}" && zsh -c "${CMD}"); then
      RESULTS="${RESULTS}- 通过：${CMD}\n"
    else
      RESULTS="${RESULTS}- 失败：${CMD}\n"
      FAILED="${CMD}"
      break
    fi
  done < "${CHECKS_FILE}"
  if [ -n "${FAILED}" ]; then
    restore_branch
    comment "$(printf '合并中止：required_checks 失败——%s。候选已恢复到冻结 SHA %s，issue 保留 in_review。\n检查结果：\n%b' "${FAILED}" "${ORIG_SHA}" "${RESULTS}")"
    die "required_checks 失败：${FAILED}"
  fi
  if [ "$(git -C "${WORKTREE}" rev-parse "${BASE}")" = "${BASE_SHA}" ]; then LANDED=1; break; fi
  echo "base 在检查期间前进，第 ${ROUND} 轮作废，重试。"
done
if [ "${LANDED}" -ne 1 ]; then
  restore_branch
  comment "阻塞：${MAX_ROUNDS} 轮内 ${BASE} 持续前进，合并中止，候选已恢复到 ${ORIG_SHA}。"
  die "base 持续变化，中止合并。"
fi

# 合并前 CAS 复核：状态与版本仍与进入时一致才允许 merge
NOW_STATUS="$("${TASKCTL}" issue get "${ISSUE_ID}" --json | "${JQ}" -r '.task.status')"
NOW_VERSION="$("${TASKCTL}" issue get "${ISSUE_ID}" --json | "${JQ}" -r '.task.version')"
if [ "${NOW_STATUS}" != "in_review" ] || [ "${NOW_VERSION}" != "${VERSION}" ]; then
  restore_branch
  comment "阻塞：合并前复核发现 issue 已变化（status=${NOW_STATUS}，version=${NOW_VERSION}），合并中止，候选已恢复 ${ORIG_SHA}。"
  die "issue 状态或版本在合并期间变化，已中止。"
fi

MERGE_MSG="land: ${ISSUE_ID} ${BRANCH}（批准：${APPROVAL}）"
if ! git -C "${MAIN_WS}" merge --no-ff "${BRANCH}" -m "${MERGE_MSG}" >/dev/null; then
  GITDIR="$(git -C "${MAIN_WS}" rev-parse --git-dir)"
  if [ -f "${GITDIR}/MERGE_HEAD" ]; then
    git -C "${MAIN_WS}" merge --abort >/dev/null 2>&1 || true
    comment "阻塞：merge --no-ff 冲突，主工作区已回滚到合并前，需人工处理。"
  else
    comment "阻塞：merge 未能完成（主工作区被其他操作占用），请人工检查主工作区状态，本脚本未做回滚。"
  fi
  restore_branch
  die "merge 失败。"
fi

LANDED_SHA="$(git -C "${MAIN_WS}" rev-parse HEAD)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RECEIPT="$(printf 'landed 回执\n- landed_sha：%s\n- 分支：%s → %s\n- 冻结 SHA：%s\n- 用户批准：%s\n- 完成时间：%s\n- required_checks 逐条结果：\n%b' "${LANDED_SHA}" "${BRANCH}" "${BASE}" "${ORIG_SHA}" "${APPROVAL}" "${NOW}" "${RESULTS}")"
comment "${RECEIPT}"

if ! "${TASKCTL}" issue move "${ISSUE_ID}" --status done --if-version "${VERSION}" --json >/dev/null; then
  die "合并已完成（${LANDED_SHA}），但 issue 转 done 失败，请手工收尾。"
fi

echo "已合并：${ISSUE_ID} landed_sha=${LANDED_SHA}（${BRANCH} → ${BASE}）"
