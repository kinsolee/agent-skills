# sub2api OpenAI OAuth helper

This helper automates the safe outer loop for adding OpenAI OAuth accounts to a sub2api admin page.

It will:

- open the sub2api accounts page
- click add account
- fill account name, remark, platform, account type, proxy, and group
- generate the authorization link
- open the authorization link in a browser tab
- wait while you complete the OpenAI login/consent flow manually
- listen on the `localhost` callback port advertised in the generated auth link, or fall back to watching the browser URL
- paste that callback URL back into sub2api
- verify whether the account appears as normal in the accounts list

It intentionally does not automate OpenAI password entry, email-code retrieval, or verification-code handling.

## Prerequisites

- Node.js >= 18

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
cp accounts.example.txt accounts.txt
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `playwright` | Automates the sub2api admin page (Chromium) |
| `@askjo/camofox-browser` | Stealth Firefox REST API for OpenAI auth (bypasses Cloudflare) |

The camofox-browser server starts automatically on port 9377 when the script runs. No manual setup needed — it's installed via `npm install`.

Edit `.env` if your sub2api URL or group name is different. Put one account per line in `accounts.txt`:

```text
email@example.com ---- any remark content you want copied into sub2api
```

The email is parsed from the beginning of each line. The full line is copied into the sub2api remark field.

## Run

```bash
npm run auth -- --accounts accounts.txt
```

Useful options:

```bash
npm run auth -- --accounts accounts.txt --admin-url http://192.168.1.49:8080/admin/accounts
npm run auth -- --one email@example.com
npm run auth -- --headless
npm run auth -- --accounts accounts.txt --keep-open-on-fail
```

During each account, finish the OpenAI login and consent in the browser tab. If the flow lands on a `http://localhost...` callback URL, the helper will catch it automatically and continue.
