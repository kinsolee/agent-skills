# ichzl email-code helper API

evidence:
- `evidence_status`: `live_verified`
- `source_system`: the iCloud-mail proxy behind `email_helper_url` Base cells (host `api.ichzl…:8443`, per-account token in the path); serves OpenAI email-verification login codes for passwordless accounts
- `captured_at`: `2026-08-13T12:45:37Z`
- `endpoint_method`: `GET <email_helper_url>`
- `provenance`: live-verified 2026-08-13 while building `flow-email-login.mjs`; four OpenAI `/email-verification` flows each produced a fresh 6-digit code here, and the code was accepted by OpenAI (the accounts were `account_deactivated`, but the code itself authenticated)
- `redaction_notes`: per-account token, account emails, code values, and message bodies are omitted; codes are short-lived

## What it is

For accounts that authenticate by **email verification code** (Base `password` empty, `email_helper_url` set), OpenAI's `/email-verification` page sends a 6-digit code to the iCloud inbox. This helper exposes the latest such code over HTTPS. Drive it with `scripts/flow-email-login.mjs`, which polls it from inside the ego-browser runtime.

## Endpoint

`GET <email_helper_url>` — the URL stored in the Base `email_helper_url` cell.

- **404** when no code email has landed in the monitored inbox yet (also the idle state).
- **200** `{ ok, email, code, receivedAt, subject, source, preview, message }` once a code arrives:
  - `code` — `^\d{6}$`, the verification code (the only field to submit).
  - `receivedAt` — ISO 8601 (e.g. `2026-08-13T12:45:37.000Z`); use it for freshness (see below).
  - `email`, `subject` (`你的临时 ChatGPT 登录代码`), `source`, `preview`, `message` — context only.

The host uses a `:8443` endpoint; the cert is valid for the host, so the ego-browser runtime's own `fetch` reaches it with **no TLS bypass** (live 2026-08-13). A Python/Node parent probing it can use `rejectUnauthorized:false` defensively, but it is not required.

## Automation rules

- **The Base cell is a Markdown link** `[label](url)`; take the URL inside the parentheses, not the bracket label (Hard Rule 12 / `flow-email-login.mjs` line 21).
- **Freshness:** the helper caches the latest code, so capture a baseline `code` BEFORE triggering a send, and accept a code only if it `!== baseline` AND `Date.parse(receivedAt) >= codePageLoadTime - 15s`. Otherwise you may re-submit a stale cached code.
- **Do NOT click 重新发送电子邮件 (Resend)** to force a code: on these accounts it crashes `/email-verification` to HTTP 500 immediately (Hard Rule 33). The auto-send on page load IS indexed — just poll (a fresh code lands within seconds).
- **Poll inside the same ego-browser call** as the code page (`fetch` loop, ~3 s interval, ~90–110 s cap). The `/email-verification` page 500s after a few minutes; a browser→Node-poll→browser split drifts into that 500.
- **The code is a secret:** keep it process-local, embed via `JSON.stringify`, never print it (Hard Rule 4). Submit it immediately on arrival.
- A code that OpenAI rejects as incorrect (`验证码…不正确` / `incorrect`) is stale/wrong — re-trigger from a fresh page load rather than guessing.

## Distinction from the MFA helper

This is the **email-verification login code** path (passwordless accounts, `flow-email-login.mjs`), unrelated to `references/nloop-mfa-api.md` (second-factor TOTP for password accounts, `flow-mfa.mjs`). An account uses one or the other based on credential shape (Hard Rule 33), never both in the same flow.
