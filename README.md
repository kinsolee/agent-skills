# Agent Skills

Kinsolee 维护的 Agent Skills 仓库，面向支持相应规范的 AI harness。每个技能包含 `SKILL.md`、脚本和参考资料，可按需使用；仓库同时提供 Codex 插件封装与市场清单，方便独立安装。

技能内容遵循公开的 [Agent Skills 格式](https://agentskills.io/specification)。插件清单采用公开的 [OpenAI 插件格式](https://developers.openai.com/plugins/build/plugins)：其他 harness 实现相应加载器后也可支持，但技能格式兼容不代表它已经支持这里的插件市场、安装命令或全部运行依赖。目前已完成的客户端安装验证是 Codex。

## 可选技能

| 技能 | 用途 | 首次使用需要 |
| --- | --- | --- |
| [sub2api-auth](plugins/sub2api-auth/README.md) | Sub2API / OpenCodex 的 OpenAI OAuth 授权、重新授权及账号池巡检 | Node.js、ego-browser、已登录的 lark-cli、管理端配置 |
| [wechat-draft-publisher](plugins/wechat-draft-publisher/README.md) | Markdown 本地预检、微信公众号草稿创建与回读验证 | Node.js 20+；写入草稿时需要公众号凭据与 IP 白名单 |

安装只加载技能和脚本，不自动执行账号操作、创建定时任务或上传文章。实际使用前阅读对应 `SKILL.md`，遵守其中的目标确认、授权及读回要求。

## 在其他 harness 中使用

按目标 harness 的技能发现或注册方式，指向 `plugins/<name>/skills/<name>/`；无需解析 Codex 插件清单也可以读取其中的 `SKILL.md`。是否支持目录链接、脚本执行及外部工具，以该 harness 的实现为准。

`wechat-draft-publisher` 的运行文件位于技能目录内。`sub2api-auth` 还依赖插件根的 `src/` 调度脚本，因此使用它时保留完整的 `plugins/sub2api-auth/` 包，并按说明设置工作目录。Node.js、ego-browser、lark-cli、凭据及调度能力仍需在目标环境配置；其他 harness 的完整业务流程尚未逐一验证。

## 安装到 Codex

需要支持 `codex plugin` 的客户端。市场标识固定为 `kinsolee`，与 GitHub 仓库名称无关。

### 从远端安装

添加 GitHub 市场后，按需安装其中的技能插件：

```bash
codex plugin marketplace add kinsolee/agent-skills

# 按需选择，可只运行其中一条
codex plugin add sub2api-auth@kinsolee
codex plugin add wechat-draft-publisher@kinsolee

codex plugin list --marketplace kinsolee
```

在客户端插件页也可以从该市场分别选择插件。安装后新建一个 Codex 任务，以加载新技能；在任务里调用所选技能。

### 从本地工作区验证

运行过业务的工作区可能有 `.env`、账号文件、浏览器状态和 `node_modules/`。先导出干净的市场目录，再安装；不要直接把运行目录作为安装源。

```bash
# 在仓库根目录执行；目标必须在仓库外且尚不存在
python3 scripts/export-marketplace.py /absolute/path/agent-skills-local
codex plugin marketplace add /absolute/path/agent-skills-local
codex plugin add sub2api-auth@kinsolee
codex plugin add wechat-draft-publisher@kinsolee
codex plugin list --marketplace kinsolee
```

导出保留当前工作区的公开源码，包括尚未提交的改动；遵循 Git 忽略规则并拒绝插件内的符号链接，不复制凭据、运行状态或依赖目录。`export-manifest.json` 记录文件哈希和导出时间。本地安装源应保留，供插件页读取元数据。

本地源和远端源是二选一；切换时先用 `codex plugin marketplace remove kinsolee` 移除旧市场来源，再添加新来源。同一市场名不要同时指向两个目录。

### 依赖、更新与卸载

含脚本的插件安装不等于安装 Node.js 依赖。在 Codex 提供的技能绝对路径下，按插件 README 执行 `npm ci --ignore-scripts`。凭据使用环境变量或私有配置，不放入版本控制，也不要依赖插件缓存永久保存凭据和运行状态。

远端更新时先运行 `codex plugin marketplace upgrade kinsolee`，再重新执行所需插件的 `codex plugin add`。维护者需为内容更新修改相应插件的版本；本地调试可使用 `plugin-creator` 的 cachebuster 更新流程，然后重新导出到一个新目录并切换本地来源。

```bash
codex plugin remove wechat-draft-publisher@kinsolee
# 不再使用整个市场时
codex plugin marketplace remove kinsolee
```

## 目录规划

```text
.agents/plugins/marketplace.json       # 市场目录：顺序、来源、可选安装策略
plugins/
  sub2api-auth/
    .codex-plugin/plugin.json         # 插件元数据
    README.md                         # 安装、配置与验证入口
    skills/sub2api-auth/               # SKILL.md、scripts、src、references、tests
    src/                              # 巡检与重授权调度脚本
  wechat-draft-publisher/
    .codex-plugin/plugin.json
    README.md
    skills/wechat-draft-publisher/     # SKILL.md、scripts、references、tests
scripts/export-marketplace.py         # 导出可用于本机安装的干净源码
tests/plugin-layout.test.mjs           # 打包、旧入口与离线导入检查
docs/superpowers/                      # 历史设计与计划，不进入插件包
skills/<name> -> ../plugins/...        # 已有本地调用的兼容入口
src/*.mjs -> ../plugins/sub2api-auth/…  # 已有调度调用的兼容入口
```

插件目录是唯一源码位置，新代码和新文档链接使用 `plugins/`。根 `skills/` 和 `src/` 的链接仅服务已有脚本与调度；确认这些调用方全部迁移后再删除。单个插件包必须自包含，不能依赖仓库其他插件或历史文档。

本机账号管理插件的 `.env` 与 `state` 可链接到原工作区对应位置，以保留现有运行上下文；这些链接受 Git 忽略且不进入导出包。安装验证不启用已有或新的调度任务。

## 开发与验证

新增插件时，创建 `plugins/<plugin-name>/.codex-plugin/plugin.json` 与 `skills/<skill-name>/SKILL.md`，再在市场文件追加一项。`name` 与插件目录名一致；市场 `policy.installation` 使用 `AVAILABLE`，因此用户可以选择安装。

复用技能内已有脚本，把所需代码、依赖锁文件、引用文档与测试放在同一插件内。运行数据与凭据不属于发布内容。现有技能业务规则以各自 `SKILL.md` 为准。

在微信技能目录安装依赖后，从仓库根执行：

```bash
node --test tests/plugin-layout.test.mjs
npm --prefix plugins/sub2api-auth/skills/sub2api-auth test
npm --prefix plugins/wechat-draft-publisher/skills/wechat-draft-publisher test
npm --prefix plugins/wechat-draft-publisher/skills/wechat-draft-publisher run check
git diff --check
```

这些是本地验证。`check-ban`、`check --refresh`、`--monitor-only`、`base-preflight` 和公众号上传不是安装测试，可能访问或修改业务系统，需按实际业务授权执行。

插件清单还应通过 `plugin-creator/scripts/validate_plugin.py` 检查，并在真实客户端安装后读回插件状态、技能路径和缓存文件。本机安装成功不代表远端内容已推送，也不代表账号授权或公众号写入已验证。

格式依据：[Agent Skills 规范](https://agentskills.io/specification)、[OpenAI 插件打包与市场文档](https://developers.openai.com/plugins/build/plugins)，核对日期 2026-09-05。
