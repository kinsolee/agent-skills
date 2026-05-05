---
name: sub2api-auth
description: Use when adding OpenAI OAuth accounts to sub2api, re-authorizing revoked or 401 accounts, or batch authorizing accounts from a file
triggers:
  - sub2api
  - oauth授权
  - openai授权
  - 重新授权
  - revoked
  - 批量添加账号
  - 账号授权
  - token revoked
  - 401
tags:
  - sub2api
  - openai
  - oauth
  - automation
  - auth
---

# sub2api OpenAI OAuth Account Automation

Automate the full lifecycle of OpenAI OAuth accounts in sub2api: batch authorization and revoked account re-authorization.

## Prerequisites

- Node.js >= 18
- Run `npm install` to install dependencies (playwright, camofox-browser)
- Run `npx playwright install chromium` for Playwright browser
- camofox-browser server auto-starts on port 9377 if not already running
- sub2api admin credentials (email/password)

## When to Use

- User wants to add OpenAI OAuth accounts to sub2api admin panel
- User mentions revoked, 401, or error accounts need re-authorization
- User has an accounts file and wants batch authorization
- User says keywords like: "sub2api", "oauth授权", "openai授权", "重新授权", "批量添加"

## Quick Reference

| Command | Purpose |
|---------|---------|
| `--accounts <file>` | Batch authorize from accounts file |
| `--check-revoked` | Scan all accounts and re-authorize revoked ones |
| `--one <line>` | Authorize a single account |

```bash
# Batch authorize
node src/authorize-openai-oauth.mjs \
  --accounts accounts.txt \
  --admin-email <email> --admin-password <password>

# Re-authorize revoked accounts (no accounts.txt needed)
node src/authorize-openai-oauth.mjs \
  --check-revoked \
  --admin-email <email> --admin-password <password>

# Single account
node src/authorize-openai-oauth.mjs \
  --one "email ---- password ---- Plan ---- token" \
  --admin-email <email> --admin-password <password>
```

## Key Options

| Option | Description | Default |
|--------|-------------|---------|
| `--admin-email` | sub2api admin email | env `SUB2API_ADMIN_EMAIL` |
| `--admin-password` | sub2api admin password | env `SUB2API_ADMIN_PASSWORD` |
| `--admin-url` | Admin page URL | `http://192.168.1.49:8080/admin/accounts` |
| `--headless` | Run browser headless | false |
| `--debug` | Verbose logging | false |
| `--timeout <ms>` | Per-account timeout | 480000 |

## Implementation Details

- **Duplicate handling**: If account exists, delete first then re-add with fresh OAuth
- **Proxy selection**: Auto-selects a real proxy (skips "无代理"/"No Proxy")
- **Virtual scrolling**: Uses search input to handle sub2api's virtual-scrolled list
- **Cloudflare bypass**: Uses camofox-browser (stealth Firefox) on port 9377, auto-started if not running
- **Consent page**: Handles OpenAI consent/continue pages automatically
- **Remark-based re-auth**: `--check-revoked` reads credentials from account's "备注" field

### accounts.txt Format

```
email@example.com ---- password123 ---- Plus ---- tok_xxxx
```

### Environment Variables

Set via `.env` file or `--env <file>`: `SUB2API_ADMIN_EMAIL`, `SUB2API_ADMIN_PASSWORD`, `SUB2API_ADMIN_URL`, `SUB2API_FORCE_PROXY`, `SUB2API_USE_CAMOFOX`, `SUB2API_CAMOFOX_URL`

## Common Mistakes

- **"备注" field empty**: `--check-revoked` requires the remark field to contain the full account line (email ---- password ---- plan ---- token)
- **Admin credentials missing**: Required for all operations; set via env or CLI args
- **Browser profile locked**: Delete `.browser-profile/SingletonLock` before runs
- **camofox not running**: Server auto-starts on port 9377; ensure the port is free

## Output

```
Summary
=======
OK  email1@example.com  ok
FAIL  email2@example.com  reason

Total: 2, success: 1, failed: 1
```

Exit code: 0 if all succeed, 1 if any fail.
