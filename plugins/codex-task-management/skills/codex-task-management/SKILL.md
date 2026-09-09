---
name: codex-task-management
description: 用 Taskboard/taskctl 管理任务规划、真实依赖、独立 worktree 接单、交付与合并。已纳入 Taskboard 的任务或明确要求派工、集成时使用；普通业务改动和只读问答不自动建卡。
---

# Codex 任务管理

Taskboard（SQLite + `taskctl`）是任务状态、依赖和派工记录的唯一来源。项目 AGENTS.md 补充业务边界与授权要求；任务书和关键事件格式见 [task-protocol.md](references/task-protocol.md)。

## 责任与协调

- 每项任务有一名责任人，直接与负责人讨论、确认方案和交付。一个任务一个责任人用于明确产物与代码归属；只读探索、评审和独立调查可继续，不因待审卡或任务数量停止。
- 默认不增设主控。用户指定协调者时，将其身份记在相关 parent issue；协调者只处理跨任务依赖、共享资源冲突、上下文变更和串行集成。子任务在已有授权内自行推进，不逐步汇报、不逐 API 向协调者申请；协调身份不产生审批权。
- 临时子代理或 CLI 可以辅助责任人；写入权仍遵守一 worktree 一 writer。创建独立 Codex 任务遵守用户授权和宿主工具约定。
- Taskboard 记录最终决定、实际阻断及交付；普通进展留在当前对话，不复制到 parent。只有影响其他任务的变化才通知相关责任人。

## 规划与接单

1. 开始时运行 `taskctl context current`，核对 project、主目录映射和已提交基线；映射错误用 `taskctl project map` 修正。同一批次需要组织层级时建 parent/children。
2. 在任务书列出目标、修改范围、责任人、真实输入合同、基线与验证要求。跨目录修改显式列出文件归属；共享文件、浏览器、设备、端口、数据库或账号有实际争用时指定唯一负责人或串行安排。
3. `blocked_by` 只记录真实依赖及原因：`functional` 为依赖上游产物，`serialization` 为共享资源必须串行。无依赖的任务保持独立。准入按实际活跃写入和资源争用判断，不以 in_progress 或 in_review 数量设上限；无需新增活动进程登记表。
4. 按授权创建或复用执行对话，提供任务书、规则入口和基线。执行者自行运行 `scripts/claim.sh <ISSUE_ID>`：首次接单要求 todo、无其他线程绑定、依赖全 done；脚本持项目锁创建或复用独立 worktree，记录路径/分支、绑定线程并转 in_progress。
5. 启动时核对正式 thread ID、接单记录、实际 Git 根目录/分支/HEAD 与 `developmentContext.path`、`.branch` 一致，再在该目录写入。`threadBinding.workspacePath` 是主目录，App 初始目录不证明隔离；一 worktree 一 writer，主目录保持主分支。只有已实际开始才报告“已启动”，临时 ID、创建请求或目录存在按实际阶段描述。

同卡恢复先读当前状态：只有 in_progress 可继续写；in_review 保持冻结，需修改先退回；已结束卡不重入。claim 的同线程重入仅补 worktree 记录，**不自动检查恢复状态、实际活跃 writer 或共享资源争用**，由责任人在调用前核验。脚本拒绝时查明原因，不改绑定或线程环境绕过。

## 上下文变更与移交

- 公共定义、合同或规则改变时，在其权威文档/issue 发布一份最终决定，列出受影响任务。只有受影响责任人重读，并在保留 dirty 改动的前提下同步包含该决定的已提交基线；记录同步后的 SHA。未提交文档不算其他 worktree 已同步；无关任务继续。
- 重派工先确认旧 writer 停止，保留候选和检查点，再解除旧绑定，由新责任人自行 claim 并核对实际目录。只读交接不转移写入权，不为移交伪造 done、退回或取消。
- 用户要求新任务替代旧任务时，创建者或协调者核验新正式 thread ID、可访问性、材料已接收及接续阶段，并确认旧任务停止且无剩余职责，随后调用宿主 `set_thread_archived` 归档旧 thread（跨主机带 hostId）并读回。该收尾无需再次询问。归档只保留历史，不删除候选、不改变 Taskboard 状态/绑定/依赖；失败记录待归档对象。新增并行任务或明确保留旧任务不算替换。

## 交付与合并

1. 责任人完成约定产物、自查和独立只读评审：先正确性，按需查复杂度，覆盖最终版本。调查可交付事实与缺口；实施方案缺关键真实合同证据不能通过。证据区分 unit / snapshot / sandbox / live。
2. 接单线程自行执行 `taskctl issue move <ID> --status in_review --thread-id <本线程ID>`，记录冻结 SHA、检查和评审结果，直接交负责人验收。跨线程 move 会清掉接单绑定；writer 此后停止修改候选。需修正先退回 in_progress，在原批准范围内继续；新增范围或权限才请求对应确认。
3. 合并沿用有效的用户批准，仅走 `scripts/land.sh <ISSUE_ID> "<批准说明>"`。脚本核对 in_review、worktree/主目录 clean、分支与仓库归属，持主目录锁 rebase，执行 `required_checks`，CAS 复核后 `merge --no-ff`，写 landed_sha 并转 done。协调者不能代替用户授权；外部业务写入仍须对应授权和真实读回。
4. 合并或文档待批只暂停依赖动作，无关已授权工作继续。取消任务转 canceled 并注明原因。完成后的 worktree/分支清理遵守项目备份与删除规则，保留 dirty 成果和 issue 历史；经验仅在有复用价值且获相应授权时沉淀。

claim/land 的锁和 `--if-version` 保护各自操作，不代替共享资源分配、评审和授权。Taskboard 备份使用文件 copy，恢复前停写，不同时编辑两份状态源。失败结果不明先读回；无法确定安全下一步时按适用规则自愈诊断。

交付 Skill 时核验运行时发现路径、内容指纹和批准样本的实际调用；文件存在或静态检查不代表加载成功。维护源码位于 [kinsolee/agent-skills](https://github.com/kinsolee/agent-skills/tree/main/plugins/codex-task-management)：先读该仓库 AGENTS.md，依其要求验证与发布，安装缓存不是修改入口。
