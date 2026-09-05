# Agent Skills 仓库维护

- 插件源码统一维护在 `plugins/<name>/`。Codex 任务管理规则见 [codex-task-management](plugins/codex-task-management/skills/codex-task-management/SKILL.md)，任务书与回执资源一起维护。
- 用户已明确要求：后续修改 `codex-task-management` 时，完成相应验证和独立审查后，将该 Skill、相关资源及必要的清单/文档变更提交到本仓库 `main` 并推送 `origin/main`，读回远端提交。此要求持续有效，直到用户撤回；不重复询问，不将本机缓存当作源码。发布内容改变时更新插件版本。
- 只暂存本次范围内的文件，保留其他未提交成果。上述授权只用于本仓库中该 Skill 的维护，不授予它所管理项目的提交、合并、推送或外部业务操作权限。
