# sub2api-auth Operations Notes

Session-derived operational details for this user's WSL sub2api OAuth automation.

## Local paths and environment

- Installed skill path: `/home/kinso/.hermes/profiles/infra-agent/skills/sub2api-auth`
- Local sub2api compose file: `/home/kinso/sub2api/docker-compose.yml`
- Admin credentials for the local container are in compose environment keys `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- Local admin URL used successfully: `http://192.168.1.49:8080/admin/accounts`
- Health check: `curl -sS -m 5 http://192.168.1.49:8080/health`
- Camofox browser service: `http://localhost:9377`

## Account-line default intent

When the user directly sends one or more lines shaped like:

```text
email@example.com ---- password ---- Plus ---- tok_xxx
```

Treat the intent as: add or retry OpenAI OAuth authorization in sub2api using this skill. Do not ask what the line means unless there is ambiguity.

## Successful add-account command pattern

Use the local compose file to avoid leaking admin credentials into chat or persistent docs:

```bash
cd /home/kinso/.hermes/profiles/infra-agent/skills/sub2api-auth
rm -f .browser-profile/SingletonLock .browser-profile/SingletonSocket .browser-profile/SingletonCookie 2>/dev/null || true
python3 - <<'PY'
import os, re, subprocess, sys
from pathlib import Path
compose = Path('/home/kinso/sub2api/docker-compose.yml').read_text()
def get(name):
    m = re.search(rf'- {re.escape(name)}=(.*)', compose)
    if not m:
        raise SystemExit(f'missing {name}')
    return m.group(1).strip()
env = os.environ.copy()
env['SUB2API_ADMIN_EMAIL'] = get('ADMIN_EMAIL')
env['SUB2API_ADMIN_PASSWORD'] = get('ADMIN_PASSWORD')
env['SUB2API_ADMIN_URL'] = 'http://192.168.1.49:8080/admin/accounts'
cmd = ['node','src/authorize-openai-oauth.mjs','--accounts','accounts.txt','--headless','true','--timeout','600000']
sys.exit(subprocess.call(cmd, env=env))
PY
```

A successful run prints:

```text
OK  <email>  ok
Total: 1, success: 1, failed: 0
```

## UI/version quirks fixed in this skill

- Playwright should not require system Google Chrome. If `/opt/google/chrome/chrome` is missing, use bundled Chromium (`npx playwright install chromium`) and do not hardcode `channel: "chrome"` unless `SUB2API_PLAYWRIGHT_CHANNEL` is explicitly set.
- Newer sub2api login page uses input placeholders `Enter your email` and `Enter your password`, and the submit button may have accessible text issues. Prefer `button[type="submit"]` for login.
- Newer sub2api OAuth wizard uses `Generate Auth URL`, not only `Generate Auth Link` / `Generate authorization link`.
- When a background authorization process is killed via Hermes, check for leftover child `node src/authorize-openai-oauth.mjs ...` processes and clean them up.

## Ban/disabled status detection

Use `node check_all_ban_status.mjs` for a read-only scan. It should:

1. Log into sub2api.
2. Read visible accounts and their remarks.
3. Submit raw account lines or tokens to `https://ban.nloop.cc/`.
4. Parse the structured `/api/openai-ban/check` JSON response and use matched `results[].status`.

Do **not** classify status by broad keyword search around an email. The ban.nloop page includes summary text such as `封禁 0 / 正常 1`, which caused a false positive for `ceciliajohnsonjgzwc@outlook.com`; the correct structured API status for that account was `normal`.

Known read-only scan output shape:

```text
BAN_SUMMARY_BEGIN
email@example.com\tok\tnormal
other@example.com\tok\tunknown
BAN_SUMMARY_END
```

`unknown` means this checker could not submit a parseable `tok_...` token to ban.nloop for that account, not that sub2api thinks the account is abnormal. Example: `halsey_isac272@outlook.com` was Active in sub2api and had a DB `refresh_token`, but its `notes` field was empty and ban.nloop only recognizes `tok_...` values, so the read-only ban checker correctly reported `unknown`.

## GitHub/source control caveat

This installed skill directory is not itself a Git repository. A previous project-memory file referenced an original path `/Users/kinso/code/projects/sub2api-auto-auth/skills/sub2api-auth`, but that checkout was not found in WSL. Before promising to push changes, verify:

```bash
git rev-parse --show-toplevel
git remote -v
gh auth status
ssh -T -o BatchMode=yes git@github.com
```

If there is no repo or auth, report that GitHub push is blocked and ask for the repo checkout/URL or GitHub credentials.
