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
| custom `check_all_ban_status.mjs` | Read-only scan of current sub2api account list and ban.nloop token status; parse structured API `results[].status` |
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

# Check current account disabled/banned status only (no reauth)
node check_all_ban_status.mjs

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

- Local WSL operational notes and session-specific pitfalls are captured in `references/local-wsl-operations.md`; consult it before adding accounts, checking ban status, or promising GitHub push.
- **Duplicate handling**: If account exists, delete first then re-add with fresh OAuth
- **Proxy selection**: Auto-selects a real proxy (skips "无代理"/"No Proxy")
- **Virtual scrolling**: Uses search input to handle sub2api's virtual-scrolled list
- **Cloudflare bypass**: Uses camofox-browser (stealth Firefox) on port 9377, auto-started if not running
- **Consent page**: Handles OpenAI consent/continue pages automatically
- **Remark-based re-auth**: `--check-revoked` reads credentials from account's "备注" field

### Remote infra-agent Camofox Requirements

Remote infra-agent authorization depends on Camofox presenting a stable Mac/en-US browser fingerprint, not just using the correct proxy exit IP. On the remote Camofox systemd service, keep these environment variables set:

```ini
Environment=CAMOFOX_OS=macos
Environment=CAMOFOX_LOCALE=en-US
Environment=CAMOFOX_TIMEZONE=America/Los_Angeles
Environment=CAMOFOX_LATITUDE=37.7749
Environment=CAMOFOX_LONGITUDE=-122.4194
Environment=CAMOFOX_GEOIP=0
```

Before debugging OAuth failures as proxy/IP problems, verify the actual Camofox page fingerprint:

```json
{
  "userAgent": "...Macintosh...Firefox/135.0",
  "language": "en-US",
  "platform": "MacIntel",
  "timezone": "America/Los_Angeles",
  "webdriver": false
}
```

If OpenAI returns `unknown_country` while the proxy exit IP matches local, inspect Camofox locale/timezone/platform/geoip first. The remote service only accepts `http`/`https` URLs for tab creation; use a real HTTPS URL such as `https://example.com/` for fingerprint self-checks, not `about:blank`.

### Automated Email Verification Code

When OpenAI requires an email verification code during login, the script **automatically**:

1. Detects the "Check your inbox" verification page
2. Opens the email helper at `email.nloop.cc` in a new browser tab
3. Pastes the full account line (email ---- password ---- plan ---- token) into the helper
4. Clicks the "获取邮件" button to fetch emails
5. Polls for the 6-digit verification code and fills it in
6. Continues with the authorization flow

**No manual intervention is needed.** Just run the script and wait for it to complete. The agent should NOT attempt to manually handle verification codes — the script handles everything internally.

### accounts.txt Format

```
email@example.com ---- password123 ---- Plus ---- tok_xxxx
```

### Environment Variables

Set via `.env` file or `--env <file>`: `SUB2API_ADMIN_EMAIL`, `SUB2API_ADMIN_PASSWORD`, `SUB2API_ADMIN_URL`, `SUB2API_FORCE_PROXY`, `SUB2API_USE_CAMOFOX`, `SUB2API_CAMOFOX_URL`

## Common Mistakes

- **"备注" field empty**: `--check-revoked` requires the remark field to contain the full account line (email ---- password ---- plan ---- token). For read-only ban checks, an empty `notes` field means ban.nloop cannot validate the account unless a parseable `tok_...` token is available; DB `refresh_token`/`rt_...` is not accepted by ban.nloop.
- **Admin credentials missing**: Required for all operations; set via env or CLI args. On this WSL setup, `/home/kinso/sub2api/docker-compose.yml` contains `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the local container.
- **sub2api login button timeout**: Newer Sub2API login page labels the submit button `Sign In` and the inputs use placeholders `Enter your email` / `Enter your password`; use `button[type="submit"]` if text-based click times out.
- **Chrome not installed**: If Playwright errors with `Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`, remove `channel: "chrome"` from `chromium.launchPersistentContext(...)` and run with bundled Chromium (`npx playwright install chromium`).
- **Generate auth link button renamed**: Newer Sub2API shows `Generate Auth URL`; include it in the auth-link button text candidates, otherwise automation fails with `Could not find generate auth link button.`
- **Banned/disabled wording**: In user-facing reports, distinguish `sub2api status` from `ban.nloop token-check status`. Never say an account is disabled/banned unless the matched structured ban.nloop API result for that account is `banned` or sub2api itself reports an error/disabled status. `unknown` means "not enough token evidence to check", not abnormal.
- **Ban status false positive**: Do not classify ban.nloop output by broad keyword search around an email because the page includes summary text like `banned: 0, normal: 1`; parse the structured `/api/openai-ban/check` JSON and use each matched `results[].status` value.
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
