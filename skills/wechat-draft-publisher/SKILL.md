---
name: wechat-draft-publisher
description: Safely create and verify WeChat Official Account drafts from Markdown. Use when publishing an article to a 公众号草稿箱, validating AppID/AppSecret and IP-whitelist access, uploading a local cover or inline images, or reading a created draft back for acceptance. This skill creates drafts only; formal publication and deletion are out of scope.
---

# WeChat Draft Publisher

Create one WeChat Official Account draft from a local Markdown file, then read it back through the official API. Keep the workflow fail-closed: local validation first, explicit external-write approval second, readback acceptance last.

## Scope

Supported operations:

- Validate article metadata, local images, credentials, and API access.
- Render Markdown into conservative WeChat-compatible HTML.
- Upload a local JPG/PNG cover as permanent material.
- Upload local JPG/PNG body images and replace their Markdown URLs.
- Create a draft with `/cgi-bin/draft/add`.
- Read the draft back with `/cgi-bin/draft/get` and verify title, cover, and content.

Treat formal publication, draft deletion, published-article deletion, article scraping, and rewriting third-party articles as separate workflows. Do not add those operations to this skill during a publishing run.

## Setup

Use Node.js 20 or later. From this skill directory, install the locked dependencies only when the user has authorized installation:

```bash
npm ci --ignore-scripts
```

Invoke the bundled `scripts/wechat_draft.sh` launcher for all commands. When standard proxy variables are present, it enables Node's environment-proxy support before native `fetch()` starts. It does not modify system proxy settings and preserves an explicit `NODE_USE_ENV_PROXY` value.

Provide credentials through the process environment or an explicitly selected gitignored env file:

```bash
export WECHAT_APP_ID="..."
export WECHAT_APP_SECRET="..."
```

`WECHAT_ACCESS_TOKEN` may replace AppSecret when another trusted system owns token refresh. Never print credentials, access tokens, token-bearing URLs, or the contents of the env file. Never search unrelated files for credentials.

Read [references/wechat-api.md](references/wechat-api.md) before changing API calls, diagnosing a WeChat error code, or updating field limits.

## Workflow

### 1. Inspect without writing

Confirm the Markdown path, selected cover, and intended target account. Check that the request is for a draft, not formal publication.

Run the local preflight. This command performs no network call and no external write:

```bash
scripts/wechat_draft.sh draft \
  --markdown "/absolute/path/article.md" \
  --cover "/absolute/path/cover.png"
```

The script requires frontmatter `title` and either frontmatter `cover` or `--cover`. It maps `source_url` or `source` to the WeChat source URL. It removes standalone production annotations such as `【截图①：...】` from the payload and reports how many were removed.

If the article contains those annotations but no real images, report that the draft will be text-only apart from the cover. Add real images only when the user requests them.

### 2. Verify API access without writing

Run the network doctor only after the account and credential source are known:

```bash
scripts/wechat_draft.sh doctor --network --env-file "/absolute/path/.env"
```

This obtains or imports an access token and reads the draft count. It does not create, update, publish, or delete content. Treat error `40164` as an IP-whitelist failure.

### 3. Confirm the external write

Immediately before execution, state that the command will upload the cover, upload any body images, and create one draft in the named WeChat account. Require explicit confirmation for that exact write unless the user's current request already clearly authorizes creating the draft.

### 4. Create and verify the draft

Run the same command with `--execute`:

```bash
scripts/wechat_draft.sh draft \
  --markdown "/absolute/path/article.md" \
  --cover "/absolute/path/cover.png" \
  --env-file "/absolute/path/.env" \
  --execute
```

The script creates the draft and immediately calls `draft/get`. Accept completion only when it returns a `media_id` and all readback checks are true. If upload succeeds but readback fails, report the `media_id`, mark acceptance incomplete, and do not retry blindly.

### 5. Recheck an existing draft

Use the read-only command when a previous run returned a media ID:

```bash
scripts/wechat_draft.sh get \
  --media-id "MEDIA_ID" \
  --env-file "/absolute/path/.env"
```

## Acceptance

Report success only with:

- the returned draft `media_id`;
- an exact title match;
- an exact cover media ID match;
- non-empty readback content containing the expected opening text.

Keep the source Markdown unchanged. Let the caller update its local status or archive only after this acceptance gate passes.
