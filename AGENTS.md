# Agent Skills 仓库维护

- 插件源码统一维护在 `plugins/<name>/`；Codex 市场登记在 `.agents/plugins/marketplace.json`，Claude 市场登记在 `.claude-plugin/marketplace.json`。
- 只暂存本次范围内的文件，保留其他未提交成果；不将本机缓存当作源码。插件内容变更完成对应验证后，按用户当次授权提交 `main` 并推送 `origin/main`，读回远端提交；发布内容改变时更新插件版本。
- 本仓库的维护授权不授予插件所管理项目的提交、合并、推送或外部业务操作权限。
