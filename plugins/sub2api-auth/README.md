# Sub2API / OpenCodex 账号管理

提供 OpenAI OAuth 授权、重新授权、MFA、手机号验证及账号池巡检流程。支持 Sub2API 和 OpenCodex；流程、授权边界与验收规则见 [SKILL.md](skills/sub2api-auth/SKILL.md)。

```bash
codex plugin add sub2api-auth@kinsolee
```

## 首次使用

需要 Node.js 18+、ego-browser 和已完成认证的 `lark-cli`。飞书表结构、管理 API 与其他运行前置条件见技能说明。安装不会配置这些外部服务，也不会启动定时巡检。

插件根目录包含 `skills/sub2api-auth/` 和 `src/`。技能里的 `node skills/sub2api-auth/...`、`node src/...` 命令均以此目录为工作目录；使用 Codex 返回的实际安装路径，不硬编码缓存版本。

优先通过进程环境提供配置。手动使用私有 `.env` 时，按 [示例](skills/sub2api-auth/.env.example) 创建在插件工作副本根目录；不要覆盖现有配置。长期运行请使用持久的私有工作副本，插件升级可替换缓存内容。OpenCodex 另有独立的管理凭据配置，按 [管理 API 说明](skills/sub2api-auth/references/opencodex-management-api.md) 设置。

常用 ego-browser/API 驱动使用 Node.js 内置模块。旧 Playwright 工具需要依赖时，在技能目录执行 `npm ci --ignore-scripts`；安装检查无需下载浏览器或执行账号流程。

## 本地验证

```bash
# 从插件根目录运行；不访问账号、飞书或浏览器
npm --prefix skills/sub2api-auth test
node skills/sub2api-auth/src/sub2api-admin-api.mjs
# 最后一条应显示 usage 并退出 2，证明 CLI 入口可执行
```

`src/sub2api-reauth-runner.mjs --monitor-only` 会运行真实巡检，可能刷新或删除账号并更新飞书记录，不能作为只读安装探针。`check-ban` 还依赖特定 WSL/Docker 部署；仅在对应业务场景下使用。
