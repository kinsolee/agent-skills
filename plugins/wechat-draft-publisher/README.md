# 微信公众号草稿发布

将 Markdown 转成适合公众号的 HTML，支持封面及正文图片上传、创建草稿和 API 回读验证。正式发布与删除不在范围内，具体流程见 [SKILL.md](skills/wechat-draft-publisher/SKILL.md)。

```bash
codex plugin add wechat-draft-publisher@kinsolee
```

## 首次使用与验证

使用 Node.js 20+，进入 Codex 返回的技能目录 `skills/wechat-draft-publisher/`：

```bash
npm ci --ignore-scripts
npm test
npm run check
scripts/wechat_draft.sh draft --markdown /absolute/path/article.md --cover /absolute/path/cover.png
```

上述测试、帮助和未带 `--execute` 的 `draft` 均为本地操作。安装本身不上传文章。

需要调用公众号 API 时，通过进程环境或显式选定的私有 env 文件提供 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET`（或已有 `WECHAT_ACCESS_TOKEN`），并按技能说明检查 IP 白名单。先预检，再获得明确写入授权，执行后读回草稿确认；不要把凭据放进插件源码或依赖缓存。
