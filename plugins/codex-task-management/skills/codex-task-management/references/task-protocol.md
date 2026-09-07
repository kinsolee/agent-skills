# 任务书与回执

任务书写进 issue description，回执写 issue comment。执行规则见 [SKILL.md](../SKILL.md)。

## 任务书（issue description）

```markdown
## 目标
<真实场景与预期行为；做什么、不做什么>

## 文件归属
- 允许修改：<文件或目录>（涉及跨目录辅助仓库时必须显式列出）
- 公共文件负责人：<负责人或 issue>

## 基线与依赖
- 主分支基线：<SHA 或分支>
- blocked_by：<issue 与原因 functional|serialization>
- 输入合同：<路径或链接>

## 交付要求
<功能、接口或数据；下游使用方式>

## required_checks
- <命令 1>
- <命令 2>

## 验证等级与证据
- 等级：<unit | snapshot | sandbox | live>
- 证据入口：<路径或 issue comment>
```

land.sh 合并前会逐条执行 `## required_checks` 小节内 `- ` 开头的命令（在交付 worktree 中），任何一条失败即中止合并且不计修正轮次。该小节每一行都会作为本地命令执行：只写验证命令，不放说明文字，不放带外部写入副作用的操作。无法用命令表达的检查写进交付要求，由验收人工判断。

## 回执（issue comment）

| 类型 | 时机 | 必含内容 |
| --- | --- | --- |
| 接单 | claim.sh 通过后自动写入 | 绑定 thread、workspace、worktree 路径与分支（脚本自动创建并写回 issue） |
| 方案送审 | 方案需要用户决策时 | 方案入口、关键取舍、缺失的授权或决策；同范围技术方案不逐次请批 |
| 阶段进展 | 有意义阶段结果时 | 产物、验收编号与证据、未完成项 |
| 阻塞 | 无法继续时 | 失败步骤、脱敏错误、最后检查点、所需决策与负责人 |
| 交付待验收 | 转 in_review 时 | 冻结 SHA、逐项自查结果与验证等级、独立评审结论、遗留项 |

交付待验收后 writer 停止修改候选；要改先退回 in_progress。

## landed 回执

land.sh 成功后自动追加：landed_sha、分支与方向、required_checks 逐条结果、用户批准说明与时间。issue 随之转 done，该回执即最终验收与合并凭证，不另写归档文档。
