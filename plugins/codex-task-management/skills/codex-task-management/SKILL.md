---
name: codex-task-management
description: 基于 Codex Taskboard（taskctl）以 issue 为数据源管理多项目并行任务：issue 规划与依赖、worktree 派工、接单与合并门禁、验收与收尾。需要规划任务、并行开发或验收集成时使用；普通业务改动不因此自动启动整套流程。
---

# Codex 任务管理

任务状态、依赖和派工记录以 Taskboard（SQLite + `taskctl`）为唯一数据源；项目内不再维护 INDEX 或任务卡。本 Skill 定义无主控工作流、门禁脚本和验收规则；项目 AGENTS.md 只补充项目事实、业务边界和指定入口。

## 项目与 issue 结构

- 开始前先跑 `taskctl context current` 确认当前会话映射的 project 与 workspacePath；映射错误用 `taskctl project map` 修正后再操作。
- 一个项目一个 project；同一模块批次建一个 parent issue，各模块任务为其 children。层级只用于规划视图，不承担执行纪律：任何 issue 都可直接派工，不要求"先主控后模块"。
- 依赖用 `blocked_by` 记录，并在任务书里写明原因：`functional`（功能上依赖上游产物）或 `serialization`（共享资源必须串行）。没有真实依赖的 issue 保持平行，不人为串联。
- 跨目录协作（如项目关联的知识库目录）默认只读。issue 需要修改辅助目录时，任务书必须显式列出该目录的文件归属；否则为辅助目录单独建 issue，不搭车修改。

## 无主控工作流

1. 规划：在 Taskboard 建 parent/children issue，写清依赖与原因；不设主控对话。
2. 派工：按 [任务书与回执](references/task-protocol.md) 把任务书写进 issue description，含 `## required_checks`。
3. 接单：在目标对话执行 `scripts/claim.sh <ISSUE_ID>`。脚本通过校验后 issue 转 in_progress 并绑定当前对话；失败即停，不手工绕过。
4. 开发：按绑定 workspacePath 建独立 worktree 和分支，bootstrap 项目规则后实现；每个 worktree 一个 writer。
5. 交付：实现与自查完成后，由接单线程自己执行 `taskctl issue move <ID> --status in_review --thread-id <本线程ID>`，comment 交付回执；writer 停止修改候选。不要跨对话代跑：跨线程 move 会清掉接单绑定，land.sh 将无法定位主工作区。
6. 退回与取消：验收不通过退回 in_progress，在原对话继续修复；需求取消转 canceled 并注明原因。
7. 验收：在 issue 对话完成独立评审与用户验收；合并必须取得用户明确批准。
8. 合并：用户批准后执行 `scripts/land.sh <ISSUE_ID> "<批准说明>"`。脚本自动 rebase、逐条执行 required_checks、`merge --no-ff` 回主分支、写 landed 回执并转 done。
9. 清理：删除 worktree 与分支、归档对话，按"复盘与清理"沉淀。

## 门禁的三层

- 脚本闸机：claim.sh / land.sh 把状态机校验（todo 才能接单、依赖全 done、WIP 上限、in_review 才能合并）固化进程序入口，不靠各对话自觉遵守约定。
- 原生约束：`--if-version` 乐观锁防并发覆盖单条更新；SQLite 单文件状态源天然排除双写。两者都防不了旧会话断线恢复后拿旧快照交作业，所以接单必须重新走 claim.sh 换新绑定，旧回执随绑定失效。
- 人工约定：脚本拦不住故意绕行（直接 `issue move`）。这是当前接受的边界；需要强制时再考虑 git 服务端钩子，现在不建。

## 硬约定

- WIP 上限：每项目同时 in_progress ≤ 2、in_review ≤ 2。claim.sh 在接单时执行准入检查并按项目加锁串行；交付转 in_review 不另设闸，超出部分由下一次接单的准入检查拦截。
- Taskboard SQLite 是唯一状态源。备份用文件级 copy；不同时编辑两个副本，恢复前先停写。
- 合并只走 land.sh，且必须在用户批准后；`--no-ff` 保留模块边界，landed_sha 写回 issue comment。
- 候选冻结：转 in_review 后 writer 不再改候选；要改先退回 in_progress。
- 验收分级：unit / snapshot / sandbox / live，按任务书声明的等级收证据；unit 通过不冒充 live 验证。

## 保留规则

- 独立评审：交付前由独立只读评审先查正确性，再查过度设计；结论必须覆盖最终版本。
- 修正轮次仅作诊断记录，不是配额；同一阻断连续两轮未解先复核根因，再凭可验证的新依据继续。
- 推进节奏：已接单任务持续推进；每轮要么完成下一个已授权动作，要么给出具体阻塞与检查点，不以"等待继续"空转。
- 失败恢复：先判断代码、环境、依赖还是外部状态问题；无法确定安全下一步时走自愈诊断，不机械重试。
- 长任务等待：绑定实际进程或会话句柄，按 ≤60 秒间隔读进度；两次空探测且无文件活动才判线程损坏。

## Skill 加载验收

交付 Skill 形态时，核验运行时发现路径、内容指纹和按批准样本的实际调用结果；文件存在不等于加载成功。项目 Skill 合入主分支即完成持久化，安装缓存不作修改入口。

## 复盘与清理

完成后提炼可复用经验回写本 Skill 或项目规则，无沉淀价值就不新增文件。清理 worktree、分支和一次性脚本；issue 保留在 board 上作为历史，不删除。

---

本 Skill 的维护源码位于 [kinsolee/agent-skills](https://github.com/kinsolee/agent-skills/tree/main/plugins/codex-task-management)。修改本 Skill 或引用资源时，先读取源码仓库根目录的 `AGENTS.md`，按该仓库约定验证、提交和推送；安装缓存不作为源码修改入口。
