---
name: sub2api-auth
description: Manage OpenAI OAuth accounts, re-authorization, provider deliveries, and SIM verification for Sub2API and OpenCodex. Use for Sub2API auth/revoked/401/account batches, MFA or phone binding, provider documents, or Cloudflare Access-protected OpenCodex management and account-pool queries.
---

# sub2api OpenAI OAuth — Agent Playbook

Agent-driven automation for the full lifecycle of OpenAI OAuth accounts in sub2api. Uses ego-browser for all browser operations, Feishu Base for persistence, and visual models for page understanding.

## Supported Platforms

Support only these account-management platforms:

- Sub2API
- OpenCodex

Treat any other management platform as unsupported until its real API contract and an end-to-end flow are verified and documented. Keep deployment hostnames, LAN addresses, account identities, and credentials in gitignored local configuration; use platform names, route paths, environment variables, or placeholders in version-controlled documentation.

## Prerequisites

- ego-browser (ego-lite) installed and running
- lark-cli configured with Feishu authentication
- Feishu Base "sub2api-auth" with tables `gpt_accounts` and `sim_cards` (resolved dynamically via lark-cli)
- sub2api admin URL accessible from ego-browser

## Configuration

Resolve at runtime via lark-cli (no .env tokens needed):

1. `lark-cli base +title-resolve --title "sub2api-auth" --as user` → `base_token`
2. `lark-cli base +table-list --base-token <base_token> --as user` → table IDs for `gpt_accounts` and `sim_cards`
3. `scripts/feishu-base.mjs` is the shared resolver + canonical schema source: `resolveBase()` does steps 1–2 (cached, optional `FEISHU_BASE_APP_TOKEN` / `FEISHU_TABLE_GPT_ACCOUNTS` / `FEISHU_TABLE_SIM_CARDS` env overrides) and every flow script imports it — **no Base/table identifiers are hardcoded in `scripts/`**. `SCHEMA` in that file is the canonical field definition for both tables.
4. `scripts/base-preflight.mjs` guarantees the configured Base matches `SCHEMA`: it auto-creates missing fields (with style + select options) and reports type mismatches / unexpected extra fields (non-destructive; `--force` to delete+recreate mismatched fields). Run it before batch/heartbeat runs and after any hand-edit of the Base. Exit 0 = consistent.
5. The sub2api instance address is configuration, not code — there is NO hardcoded default. `SUB2API_ADMIN_BASE` (instance origin) or the legacy `SUB2API_ADMIN_URL` (panel URL; any `/admin/accounts` tail is stripped) must be set in `.env` (gitignored) or the process environment; `src/sub2api-admin-api.mjs` fails fast with a clear error when unset.
5. `SUB2API_ADMIN_API_KEY` (admin REST API key, `x-api-key` header) lives in the same `.env`. The automation calls the admin API directly through `src/sub2api-admin-api.mjs`; no browser login to the admin panel is needed. Never print the key or the instance URL values. See `references/sub2api-admin-api.md` and `.env.example` for the key inventory.

## OpenCodex Management API

For any configured OpenCodex deployment, read [references/opencodex-management-api.md](references/opencodex-management-api.md) before calling an `/api/*` management route. Send both Cloudflare Access service-token headers and the distinct OpenCodex management token. Keep the Codex data-plane token separate even though both OpenCodex layers accept a header named `x-opencodex-api-key`.

Use `node skills/sub2api-auth/scripts/opencodex-providers.mjs` for the canonical read-only `GET /api/providers` probe. Use `node skills/sub2api-auth/scripts/opencodex-account.mjs check --refresh` for the OpenAI/ChatGPT account-pool patrol; reauthorize only rows it classifies as `needsReauth` or `reauth_required`. Both derive the public management origin from the active Codex provider config, load credentials without printing them, reject Access redirects, and emit only allowlisted metadata.

## Reusable Scripts — check `scripts/` before writing anything

`skills/sub2api-auth/scripts/` holds live-verified browser drivers. ALWAYS reuse or extend these; never rewrite one from scratch because a temp copy was deleted (2026-08-06 lesson: rewriting cost a full session). All follow the same contract: read secrets from Base in-process by `record_id`, embed them via `JSON.stringify` into the piped ego-browser script (Hard Rule 22), and mask every secret in output. The ego-browser nodejs API signatures (`typeText`, `fillInput`, task-space lifecycle, tabs) are in [references/ego-browser-api.md](references/ego-browser-api.md) — read it before typing into any input or managing a task space; the functions are opaque proxies whose arg shapes must be learned once. The table below is the canonical inventory — anything an automated run (heartbeat, launchd, or manual) needs to do in the browser MUST map to a row here; new capability is added by extending a script and adding a row, not by emitting a throwaway temp script (Hard Rule 32).

| Script | Usage | Does |
|--------|-------|------|
| `flow-login.mjs` | `<gpt_record_id> <space_id> <auth_file.json>` | Fresh auth-URL load → email → password (native setter + `requestSubmit`, Hard Rules 14/15/23) → polls the transition. Live-verified 2026-08-05/06. |
| `flow-email-login.mjs` | `<gpt_record_id> <space_id_or_name> <auth_file.json>` | Passwordless email-code login for accounts whose Base `password` is empty but `email_helper_url` is set (email-verification accounts). Single ego-browser call: typeText email → `/email-verification` → in-runtime `fetch` loop against the ichzl helper (`email_helper_url`) → typeText code → outcome (`CALLBACK_REACHED` / `account_deactivated` / `code_rejected`). See Hard Rule 33. Live-verified 2026-08-13 across 4 accounts. |
| `flow-mfa.mjs` | `<gpt_record_id> <space_id> [platform_url]` | Email-keyed TOTP via the platform's keyless JSON API (`GET <platform>/api/mfa/lookup`, contract in `references/nloop-mfa-api.md`): in-process lookup by Base email, waits for a fresh code when `remaining<5s`, then fills+submits on the `mfa-challenge` tab. Live-verified end to end 2026-08-12: 4/4 OpenCodex targets found with fresh codes and five accepted MFA submissions across four accounts; the former browser-UI query path was removed after it returned 0 rows for accounts that had live API records. |
| `flow-email-otp.mjs` | `<gpt_record_id> <space_id> --challenge-start-ms <epoch-ms>` | Last-resort iCloud email OTP fallback after MFA/TOTP is observably unavailable. Binds selection to strict sender, optional exact recipient metadata, post-challenge delivery time, newest-first ordering, and one unique six-digit code. The existing helper contract has no evidenced recipient/time field names, so its adapter fails closed. The not-found branch is live-verified; successful retrieval/submission is not. |
| `flow-consent.mjs` | `<record_id> <space_id> --mode create --session-id <sid>` or `--mode apply --id <acct> --session-id <sid>` | Identity gate (consent email must equal Base email) → consent click → callback capture from current URL or CDP `Page.getNavigationHistory` → admin-API `create`/`apply` (create uses fleet canonical proxy_id=1, group_ids=[2], concurrency=10, priority=1). Prints a masked account summary. Live-verified 2026-08-06 ×4. |
| `flow-jihuo-mfa.mjs` | `<gpt_record_id> <space_id>` | `2fa.jihuo.plus` fragment-keyed TOTP driver — the URL hash IS the per-account seed; the page renders the 6-digit code into `#codeDisplay` and a countdown into `#timeRemaining`. Validates the fragment is present (Hard Rule 12), auto-refreshes under 6 s, fills+submits on the `mfa-challenge` tab. The TOTP seed (location.hash) must NEVER appear in cliLog or stdout (Hard Rule 4). Live-verified 2026-08-06/07. |
| `flow-totp-local.mjs` | `<gpt_record_id> <space_id>` | Secret-keyed TOTP fallback (Hard Rule 17 secret-keyed shape): reads Base `mfa_secret`, computes RFC 6238 TOTP (HMAC-SHA1, 30 s window, 6 digits) over the Base32-decoded seed locally, fills+submits on the `mfa-challenge` tab. Use when an MFA platform page fails/unreachable and the account has `mfa_secret`, or for any `2fa.run`-style secret-paste platform. Sanity-checked against the RFC 6238 SHA1 test vector. Never print `mfa_secret` (Hard Rule 4). Added 2026-08-07. |
| `flow-add-phone.mjs` | `<gpt_record_id> <sim_record_id> <space_id>` | SIM phone binding on the OpenAI `add-phone` → `phone-verification` flow (US `+1` direct-channel numbers). Implements Hard Rules 29/30/31 end to end: `cdp('Page.reload')` inbox polling (not `snapshotText()`), explicit `重新发送短信` click with re-click at ~round 6/14, 90 s hard cap, leading-`1` strip for 11-digit numbers. Writes SIM bookkeeping and `bound_phone` per Hard Rule 21. Live-verified 2026-08-07 on #185. |
| `repair-mapping.mjs` | `<account_id> [ref_id,ref_id,...]` (refs default `158,113,124,170`) | Full-metadata credentials PUT with the canonical ≥20-entry `model_mapping` (Hard Rule 19 compliant), readback verification with token-lag retry (Hard Rule 26), SSE `/test` with EOF retry. Idempotent: re-run safely after a partial pass. Live-verified 2026-08-06 ×4. |
| `opencodex-account.mjs` | `check --refresh` or `start/status/submit/cancel` with `--auth-file` | Canonical OpenCodex account-pool patrol and OAuth management driver. Uses one protected runtime lock across sessions, validates callback stdin, and emits redacted outcomes. Live-verified 2026-08-12 across the full path: inventory/patrol, start/login, explicit `account_deactivated`, second-factor failure branches, `DELETE` of terminal accounts with readback, callback submission, credential persistence, and same-account fresh-health success after reauth (4 accounts). |
| `flow-opencodex-consent.mjs` | `<gpt_record_id> <space_id> <auth_file.json>` | OpenCodex-specific consent identity gate, post-gate loopback callback recovery, strict validation, and stdin submission executed from the parent Node runtime (the ego-browser embedded runtime cannot exec Node — proven 2026-08-12 by two silent submit failures). Any consent, callback, or submit failure invokes canonical cancel. Callback submit, credential persistence, and same-account fresh-health success live-verified 2026-08-12 on four pool accounts. |
| `feishu-base.mjs` | (shared module, imported — not a CLI driver) | `resolveBase()` dynamically resolves the Feishu `base_token` + both table ids via lark-cli (no hardcoded identifiers; optional `FEISHU_*` env overrides); `SCHEMA` is the canonical field definition for both tables. Every flow script imports it. Added 2026-08-13. |
| `base-preflight.mjs` | `[--force] [--quiet]` | Ensures the configured Base matches `SCHEMA`: auto-creates missing fields (with `style` + select `options`), reports type mismatches and unexpected extra fields. Non-destructive; `--force` delete+recreates type-mismatched fields (column data lost). Exit 0 = consistent. Run before batch/heartbeat runs. Added 2026-08-13. |

For Sub2API, `<auth_file.json>` is the `--raw` output of `generate-auth-url` (`{"authUrl","sessionId"}`); keep its `sessionId` for `flow-consent.mjs`. For OpenCodex, `opencodex-account.mjs start` writes `{"accountId","flowId","authUrl","oauthStateHash"}` for the OpenCodex drivers. OpenCodex auth files must be direct children of `~/.opencodex/oauth-flows/`, outside the repository, at mode `0600`; that directory and its single `.opencodex-reauth.lock` are `0700` and `0600`. Stale recovery requires a dead owner PID and an expired 30-minute TTL. If no state can be derived from the protected auth URL, local state binding is unavailable and the pending server flow remains the validation authority. New Sub2API accounts need `repair-mapping.mjs` right after `create`; reauth needs the mapping check after every `apply`.

## Scheduled Reauth Automation

Primary scheduler (since 2026-08-06): a **Codex hourly heartbeat automation** (`sub2api 每小时重新授权巡检`, attached to the sub2api working task) runs the patrol visibly inside the Codex app — every hourly run reports silent recoveries, per-account interactive reauth outcomes, and parked accounts directly in the task, so success/failure is always observable. Each patrol:

1. `node src/sub2api-reauth-runner.mjs --monitor-only` — runs `src/sub2api-monitor.mjs` (silent admin-API refresh recovery for error-state accounts = Flow C step 0, expired removal, config and capacity checks), reconciles the queue, and prints one JSON line: `{silent_recovered, queue, parked}`. It never spawns a nested agent in this mode.
2. If `queue` is empty: append the run to `state/reauth-history.jsonl` and report one line.
3. If `queue` is non-empty: the Codex task itself performs Flow C for each queued account using the Reusable Scripts (`flow-login.mjs`, `flow-mfa.mjs`, `flow-consent.mjs --mode apply`, `repair-mapping.mjs`), then `node src/sub2api-reauth-runner.mjs --post-reconcile` re-runs the monitor and updates per-account attempt tracking in `state/reauth-runner-state.json` (an account failing 3 consecutive hourly attempts is parked for human attention instead of being retried).

The patrol is fully unattended: CAPTCHA/slider/handoff situations must be resolved automatically per the Error Recovery table or the affected account is marked `manual_required` in Base and skipped — there is no interactive user to hand off to. Records: per-run JSON lines in `state/reauth-history.jsonl`, runner detail in `state/reauth-runner.log`, and the visible hourly report in the Codex task.

Fallback/legacy: the launchd job `com.kinso.sub2api-reauth` (runs the same runner in `full` mode, which spawns a headless `codex exec` agent when the queue is non-empty) is **disabled** (`launchctl bootout`, 2026-08-06) because its headless runs left no user-visible record; its plist remains at `~/Library/LaunchAgents/com.kinso.sub2api-reauth.plist` and can be reloaded if the Codex app will be closed for extended periods (Codex automations only fire while the app is running). Never enable both schedulers at once.

## Hard Rules

1. **Source-specific validation**: Direct user-pasted one-click-copy text is a first-class source and does not require visual/OCR validation. Every critical value extracted only from screenshots—including credentials, URLs, identifiers, provider/order metadata, stated quantity, and timestamp—must still be read by two visual models independently; adopt it only if both agree. When identified direct-copy text conflicts with screenshot OCR, prefer the direct value only after structural validation and record the source distinction in the redacted preview without echoing the value.
2. **Standing authorization on valid paste**: A structurally valid pasted `=== 使用说明 === / === 卡密内容 ===` order text that passes format validation, quantity check, dedup, and type-evidence gates is treated as explicit batch authorization. After parsing, echo a redacted structured preview with observed counts, source mode, missing fields, validation state, duplicate-check state, and one masked row per parsed item. If no blockers remain, write to Feishu Base and start authorization (or resume) immediately without asking for additional confirmation. Hard stops that still block auto-execution: structural validation failure, stated-quantity mismatch, unresolved duplicate conflict, Base API permission error, and sub2api admin login failure with no inherited session.
3. **HTML entity provenance**: Keep screenshot OCR raw. Decode entities only for values proven to come from HTML source/DOM text, using standards-compliant decoding.
4. **Redact in all output**: Never show full passwords, tokens, MFA secrets, emails, phone numbers, authorization URLs, callback URLs, or token-bearing URLs in stdout, `cliLog`, commentary, progress reports, errors, cleanup messages, or final output. Use `***` masking and show only non-secret URL origins when useful.
5. **No local credential cache**: Feishu Base is the single source of truth.
6. **sub2api remark field**: Leave empty. Do not store credentials there.
7. **ego-browser task space isolation**: Each account authorization uses its own task space. Complete it when done.
8. **Observe-act-verify loop**: Every browser action follows: snapshotText/screenshot → reason → act → snapshotText/screenshot to verify.
9. **Check known-ui-patterns.md first**: Read the evidence status before using a pattern. Treat `screenshot_inferred` as a hypothesis, `snapshot_verified` as observed structure only, and `live_verified` as a completed path. After successful live observation or end-to-end completion, update provenance and promote the status only to the level actually proven.
10. **Sensitive Base reads stay silent**: Use `--field-id` projections for only the fields needed by the current step. Capture credential-bearing JSON into a process-local variable and do not let the raw row reach stdout, `cliLog`, commentary, or final output. Do not persist it to local JSON/temp files.
11. **Exact browser ownership branches**: Ordinary later rounds start with `useOrCreateTaskSpace(<numeric-id>)` — numeric IDs are reuse-only and never create a space; create a dedicated space with a string name `useOrCreateTaskSpace("<task-name>")` and pass the returned numeric id to the drivers, then close it with `completeTaskSpace(id, { keep: false })` when the account finishes (see `references/known-ui-patterns.md` → "ego-browser task-space lifecycle for isolated account flows"). After a confirmed handoff or unexpected takeover, resume with `takeOverTaskSpace(<numeric-id>)`. For a confirmed inactive, unassigned, or user-owned space, use `listTaskSpaces()`, `claimTaskSpace(id)`, `listTabs()`, then `switchTab(targetId)`. A user-control error is a hard stop until explicit confirmation.
12. **Normalize Base URL cells before browser use**: A Base URL-style text cell may read back as a Markdown link such as `[label](https://...)`. For recognized Markdown-link cells, prefer the URL inside the parentheses; otherwise retain the raw value. Validate the normalized scheme and expected origin/shape, keep it process-local, and never print it.
13. **Condition-based Base readback**: A successful Base write response is not the completion proof. Poll a projection of the exact record ID until every expected field matches or a bounded timeout expires. A transient stale read must not be reported as either success or permanent failure.
14. **Password fields: native setter only**: ego-browser's `fillInput` may append to an existing value instead of replacing it on OpenAI password inputs, silently doubling the password. Always set password fields via `js()` using the native `HTMLInputElement.prototype.value` setter, dispatching `input` and `change` events with `{ bubbles: true }`. Verify the filled length matches the expected length before submitting. Do not use `fillInput` for `input[name="current-password"]` or any credential-bearing input that already has a value.
15. **OpenAI form submission via requestSubmit**: The OpenAI auth password form uses React Router. Clicking the submit button with ego-browser's `click()` may trigger a native form POST that is intercepted by OpenAI's sentinel bot-detection iframe and times out. Instead, call `form.requestSubmit(buttonElement)` via `js()` to trigger React Router's fetch-based submission path, which passes through the browser's existing Cloudflare session. The password verification endpoint is `/api/accounts/password/verify` (POST, JSON body `{"password":"..."}`) — do not use `/api/accounts/authorize/continue` for the password step.
16. **OAuth identity is a hard gate**: ego-browser task space isolation does not guarantee a fresh OpenAI login state; a new space can inherit an account chooser or authenticated session for a previous account. Before consent, require the provider-visible email to exactly match the target Base record. On an account chooser, select `Log in to another account` / `登录至另一个帐户` unless the displayed account exactly matches the target. Never infer identity from the sub2api account name, callback success, or `正常` status. Before marking Base active, require the Sub2API backend credential identity to match the target Base email, `has_access_token=true`, `has_refresh_token=true`, current credential metadata, `status=active`, `schedulable=true`, empty error, and an SSE model test ending in `test_complete success=true`.
17. **MFA-first verification**: When OpenAI requires second-factor verification and an authenticator/MFA/TOTP path is offered, always attempt MFA before email OTP. An account's MFA availability is determined by the OpenAI challenge page, not only by Base `mfa_platform_url`; when the field is empty, probe the known MFA platform (`2fa.nloop.cc`) with the target email before choosing email OTP. After a successful MFA-first result, update the Base record's `mfa_platform_url` if it was previously empty. Three MFA platform shapes exist:
    - **Email-keyed** (e.g. `2fa.nloop.cc`): query the platform's keyless JSON API by account email (`references/nloop-mfa-api.md`) — no platform page needed. Drive with `scripts/flow-mfa.mjs <record_id> <space_id> [platform_url]`.
    - **Secret-keyed** (e.g. `2fa.run`): paste the Base `mfa_secret` TOTP seed into the platform page. Drive by reading `mfa_secret` from Base and pasting it into the platform, or compute locally (RFC 6238, base32 HMAC-SHA1, 30 s window) when the platform page fails.
    - **Fragment-keyed** (e.g. `2fa.jihuo.plus`): the URL fragment itself is the per-account TOTP seed — no email/secret input is needed, the page reads the hash on load. The fragment is easily lost when Base cells are round-tripped through Markdown links, so the driver MUST validate its presence and length before launching the browser. Drive with `scripts/flow-jihuo-mfa.mjs <record_id> <space_id>`.
   Pick the shape by the platform host and observed input, never by URL alone; when a platform page fails and the account has `mfa_secret`, computing TOTP locally from the seed is an acceptable fallback.
18. **Never fork the OpenAI auth-flow state**: Do not drive OpenAI login steps from outside the page's own flow. Calling `/api/accounts/authorize/continue` via standalone `fetch`/`js()` and then hard-navigating to `/log-in/password` returns `200 login_password` for the email step but permanently forks the server-side login-flow state, so every later `/api/accounts/password/verify` fails with `401 invalid_username_or_password` even when the submitted password is byte-exact (proven 2026-08-03 by a probe that sent the checksum-verified correct password and still got 401). Always let the page's own React flow perform each step (fill input, click the real Continue control). Recover from a stuck or timed-out step by restarting the whole flow fresh (close tab, reopen the authorization URL), never by bypassing the form with a direct API call.
19. **Admin account PUT is replace, not merge**: `PUT /api/v1/admin/accounts/<id>` replaces every non-token field inside `credentials`; only the access/refresh/id tokens survive server-side. A partial `{"credentials":{...}}` body silently wipes `email`, `plan_type`, `client_id`, `chatgpt_account_id`, `chatgpt_user_id`, `organization_id`, `subscription_expires_at`, and `expires_at` (proven 2026-08-04 when a `model_mapping`-only repair PUT damaged 11 accounts). Any PUT that touches credentials must first GET the current account state and then re-send the COMPLETE credential metadata in one body. Never send a partial credentials payload.
20. **Admin operations are API-first**: Drive every sub2api management operation through the admin REST API via `src/sub2api-admin-api.mjs` (`x-api-key` auth from `SUB2API_ADMIN_API_KEY`), not by automating the admin panel UI. Generate the auth URL (`generate-auth-url`), create the account (`exchange-code` → `accounts.create`), re-authorize (`exchange-code` → `apply-oauth-credentials`), read back, test, set schedulable, and delete all through API calls. The browser is reserved exclusively for the OpenAI user flow on `auth.openai.com` (password, MFA, phone binding, consent) — it only needs to open the API-generated `auth_url` and surface the callback `code`+`state`. Keep the API key process-local and never echo it; the helper redacts token-bearing fields by default. The panel UI dialogs are the fallback only when the API is unreachable. See `references/sub2api-admin-api.md`.
21. **`bound_phone` is a mandatory co-write on phone-binding success**: When this run completed a new phone binding (OpenAI's `auth.openai.com/phone-verification` was reached and a code was accepted), the GPT record's initial-authorization upsert MUST carry `sub2api_status=active`, `auth_time`, AND `bound_phone=<national number>` in one `+record-upsert` call. A successful upsert response is NOT proof; the post-write readback (Hard Rule 13) MUST confirm `bound_phone` matches the just-bound number before declaring the account active. For re-authorizations that also complete a new phone binding, also include `bound_phone`. When no new phone binding was performed (MFA → consent path), do not invent a value — leave `bound_phone` as observed in the readback. Incident 2026-08-04: sub2api #166 reached phone-verification and was bound to `14709315421`, but the GPT upsert only set `active`+`auth_time`, leaving `bound_phone` empty until manual backfill.
22. **ego-browser scripts run in a separate service process**: The `ego-browser nodejs` runtime executes scripts inside the browser service, NOT in your shell — shell environment variables set in the calling command are invisible to the script (`process.env.X` is empty), and `@N` snapshot refs do not survive across heredoc rounds. Consequences: (a) secrets (passwords, emails, MFA URLs) must be read from Base in-process by a generator script and embedded into the piped browser script via `JSON.stringify` on stdin — never via env vars, never in command text, never persisted to disk; (b) when spawning `ego-browser` from Node, capture BOTH stdout and stderr — `cliLog` output arrives on the child's stderr; (c) always take a fresh `snapshotText()` in the same round before using `@N` refs, or use `loc=`/CSS selectors; (d) `switchTab` requires the tab object from `listTabs()`, not an id.
23. **OpenAI form timeouts require a fresh page load, not retry loops**: After an `Operation timed out` error page on auth.openai.com, the form restored by clicking 重试 is half-hydrated: its submissions fall through to a native form POST that the sentinel iframe intercepts, so every submission on the restored page times out again (proven 2026-08-05 across email and password steps on 4 accounts). Recovery: click 重试 at most once to observe; if any form step times out again, immediately reopen the authorization URL fresh (`openOrReuseTab(authUrl)`) and redo the form flow — a fully loaded page routes submissions through React Router's fetch path and normally succeeds on the first attempt. Never loop more than one 重试 round on a restored page. The same transient upstream also produces `EOF` errors on the sub2api SSE `/test` endpoint (`Post "https://chatgpt.com/backend-api/codex/responses": EOF`); retry the test 1–2 times (with a few seconds' pause) before concluding the account is broken.
24. **chongpt stale-code trap on slot restoration**: When an already-redeemed CDK is re-verified to restore its slot, the 6-digit code visible in the 验证码 input is usually the OLD code from the previous session — submitting it to OpenAI yields `验证码错误` (proven 2026-08-06 on #174: stale code rejected, the fresh code after clicking 刷新验证码 was accepted first try). Record the displayed code first, click 刷新验证码/再次接收, and only accept a code DIFFERENT from the recorded one (or a fresh `验证码已收到` marker without `与上次相同`). A code arriving on the very first refresh round with no prior code displayed is fresh by definition (#177 case).
25. **Code-sent detection needs URL + input, not page text**: The string `一次性验证码` appears in the add-phone page's own descriptive copy (`我们会向该号码发送一次性验证码进行验证`), so matching it false-positives before any SMS is sent. Require `pageInfo().url` containing `/phone-verification` AND `input[name="code"]` present in the DOM before treating the phone step as code-sent (observed false positive 2026-08-06).
26. **Token readback lag after credentials PUT**: A GET immediately after `PUT /api/v1/admin/accounts/<id>` can transiently report missing access/refresh tokens even when the PUT body carried the complete credentials including tokens (observed twice on 2026-08-06, #176/#177; lag exceeded 6 s). Retry the readback (`repair-mapping.mjs` polls up to 5×3 s) before declaring a Hard Rule 19 wipe; the SSE `/test` ending `test_complete success=true` is the decisive health proof. Do not re-apply credentials solely because of a transient empty-token readback.
27. **MFA driver selection is by URL host, not by field name**: When the heartbeat or the orchestrator reaches the MFA step, choose the driver by parsing the host of `Base.mfa_platform_url` (the `https?://(host)/...` part):
    - `2fa.nloop.cc` (or any email-keyed domain serving `/api/mfa/lookup`) → `scripts/flow-mfa.mjs`. Its API lookup returns `found:false` when the platform has no record for that email; that is the signal to fall back per the Error Recovery table.
    - `2fa.jihuo.plus` (or any fragment-keyed domain) → `scripts/flow-jihuo-mfa.mjs`. Passing `flow-mfa.mjs` instead would email-query a domain that doesn't have an inbox and produce `NO_CODE`.
    - All other hosts are an unsupported shape → mark the account `manual_required`, append a redacted diagnostic to `notes`, and skip per the Error Recovery table.
   Proven 2026-08-07 (#178/#181/#182/#180 in one heartbeat): a batch that looked like 2fa.nloop.cc accounts actually used 2fa.jihuo.plus (fragment-keyed); the first nloop.cc probe found no record for any account and would have stalled the patrol indefinitely.
28. **Silent refresh 502 with EOF must distinguish transient EOF from refresh_token_invalidated**: `sub2api-monitor.mjs` currently treats every silent-refresh failure (502 EOF on `auth.openai.com/oauth/token`) as a queue-worthy error, but the underlying cause is often `refresh_token_invalidated` (401 `invalid_request_error`, "Your session has ended") wrapped in a 502 — proven 2026-08-07 on #180: monitor queued for Flow C, but a manual `refresh` immediately revealed a 401 invalid_grant that no retry could fix. Refine the classifier:
    - If the response body contains `refresh_token_invalidated` or `Your session has ended` → hard fail: queue for interactive Flow C (current behaviour, correct).
    - If the response is a bare EOF / network error and there have been <2 prior refresh attempts within the same monitor run → retry once with a 3–5 s pause, then re-classify.
    - Otherwise → queue for interactive Flow C.
   This avoids wasting one browser round per OAuth refresh-token expiry.
29. **`snapshotText()` does NOT trigger HTTP fetches; `openOrReuseTab(url)` does NOT refresh existing tabs** (proven 2026-08-07, account #185). For static SMS-inbox pages (e.g. `sms688.cc`, `k.sms688.cc`) the body is rendered server-side and only updates when a fresh HTTP GET hits the URL. `snapshotText()` only reads the current DOM via CDP, so polling it in a loop is a no-op — the same `暂无短信` text is read 50 times in a row. `openOrReuseTab(url, { wait: true })` reuses an existing tab if one matches the URL; it does NOT force a reload. For real polling refresh:
       - Switch to the SMS tab with `switchTab(...)` (use the tab object from `listTabs()`, not an id).
       - Call `await cdp('Page.reload', { ignoreCache: false })` on that tab to force a fresh HTTP GET.
       - Then `await sleep(1500–3000)` for the round-trip, then `snapshotText()` to read the updated inbox.
   Building a polling loop with `openOrReuseTab(SMS_URL)` per round as the refresh mechanism is broken — the script will appear to spin for the full timeout without ever seeing the SMS. Always use `cdp('Page.reload')` for inbox-style pages and any time `snapshotText()` returns the same content on consecutive rounds.
30. **OpenAI `phone-verification` does NOT auto-send the SMS on page-entry; an explicit `重新发送短信` click is required** (proven 2026-08-07, accounts #184/#185). Observed: on entry to `/phone-verification` after a successful `add-phone` submit, OpenAI does not push the OTP until the user (or agent) clicks the `重新发送短信` button. Polling the SMS inbox URL — even with `cdp('Page.reload')` — returns `暂无短信` indefinitely until the button is clicked at least once. Required pattern:
       - After the page transitions to `/phone-verification`, switch to that tab and click `重新发送短信` ONCE before entering the polling loop (`<button>` whose visible text contains `重新发送`).
       - If the first reload poll round (5–10 s after the first click) finds no code, click `重新发送短信` again at ~round 6 and again at ~round 14 (≈30 s and ≈70 s) in case the first SMS request was suppressed by per-IP risk control (Hard Rule 25–adjacent).
       - Hard-cap the poll loop at 90 s total wall time. If no code by then, classify as `cooldown` (1-hour SIM backoff, not 3-day — OpenAI is rate-limiting the IP, not the SIM). Never indefinite-loop the inbox reload.
   Hard Rule 30 supersedes the previous "wait up to 120 s and observe" guidance (known-ui-patterns.md "OpenAI OAuth — Phone Binding" step 6) for static SMS-inbox providers like `sms688.cc`; that 120 s budget referred to chongpt-style platforms where the page itself streams updates.
31. **US E.164 `+1XXXXXXXXXX` is the de facto default for 11-digit "1"-prefixed numbers; OpenAI's country dropdown does NOT include `中国` (China)** (proven 2026-08-07, account #183). Observed: when the user-provided phone number is 11 digits and starts with `1` (e.g. `13035058176`, `14108006205`, `13464530516`), it is US format, NOT mainland China — the leading `1` is the `+1` country code prefix, and the national part is the trailing 10 digits (area code + 7-digit local number). The native OpenAI `<select>` countries list contains 234 entries but does NOT include `中国` (`CN`); `中非共和国` (`CF`) is the last alphabetically. Implications:
       - In `flow-add-phone.mjs`, strip the leading `1` from a 11-digit number to get the 10-digit national part; never try to switch the country away from the default `美国 (+1)` for these providers.
       - If the country selector was inadvertently changed (e.g. by an earlier click of the country button that landed on the first dropdown row), force the select back: `document.querySelector('select').value = 'US'` followed by a `change` event, then verify `select.value === 'US'` and the visible country button shows `美国 (+1)` before filling the number.
       - User packs delivered as `邮箱———密码：X———2fa密钥：Y———取码网址` and `phone----sms_url` with phone numbers starting `13x/14x/15x/16x/17x/18x/19x` (1 + 10 digits) are US. Do not parse them as `+86` China; doing so will leave the country selector on the default +1 (correct) but print a misleading "national part = 130xxxxxx" with 11 digits and break the input formatter.
      - China-bound SIMs must use a different provider / channel (chongpt redemption cards producing non-China numbers, or `+1`/`+852`/`+886` reissued numbers) — direct-pack `中国大陆` 11-digit numbers are unusable on auth.openai.com.
32. **Reuse-first / adapt-don't-fork / persist-after-adapt (the automation contract)**: Every automated run (heartbeat, launchd, or manual loop) MUST exhaust the Reusable Scripts table above before doing any browser work — the scripts in `skills/sub2api-auth/scripts/` are the only sanctioned browser drivers. Do NOT generate a throwaway temp script (heredoc, `mktemp`, an untracked `.mjs`) that duplicates a reusable script's responsibility; that is how live-verified logic gets silently lost or forked. The only time the model writes code during a run is to handle a **genuinely new** error, page, or edge case that no reusable script and no Error Recovery / Hard Rule row already covers — and even then the fix is made by **editing the reusable script itself** (generalizing it, with a dated inline comment naming the new trigger), NOT by forking a temp copy. Every such adaptation closes the loop in the same run: (a) extend the script; (b) add a row to the Reusable Scripts table if new, and record the new error in `Error Recovery` or as a new Hard Rule with a date + evidence; (c) commit + push the skill change via the heartbeat's skill-sync step before reporting the run done. An adapted script that stays in an untracked temp file at end-of-run is a failed run. Tempting as it is, do not "just fix it inline this once" — if the case is real it belongs in the script; if it is a one-off (e.g. a malformed paste), handle it without writing code.

33. **Passwordless email-code login for no-password accounts** (proven 2026-08-13, 4 OpenCodex reauth accounts): when a queued/reauth account's Base `password` is empty but `email_helper_url` is set, the account authenticates via OpenAI's email-verification-code path, NOT the password path. `flow-login.mjs` exits `missing inputs` on an empty password — that is the signal to switch to `scripts/flow-email-login.mjs` (`<gpt_record_id> <space_id_or_name> <auth_file>`). The whole path runs inside ONE ego-browser call (a multi-call browser→Node-poll→browser design drifts, and the code page is fragile):
   - Load the auth URL → typeText the email into `input[name="email"]` → `requestSubmit`. email AND code inputs MUST use `typeText` (real keystrokes); the native value setter used by flow-login leaves React controlled-component state empty, so `requestSubmit` no-ops on these React inputs.
   - The page goes to `/email-verification` ("检查你的收件箱") and OpenAI auto-sends a 6-digit code to the email. Wait for `input[name="code"]`.
   - Retrieve the code from the ichzl helper ([references/ichzl-email-helper-api.md](references/ichzl-email-helper-api.md)): `GET <email_helper_url>` returns 404 until the code email lands, then HTTP 200 `{ok,email,code,receivedAt,subject,...}`. The ego-browser runtime's own `fetch` reaches it directly (the ichzl cert is valid for the host — no TLS bypass). ichzl caches the latest code, so capture a baseline BEFORE the send and accept a code only if it differs from the baseline AND `receivedAt` ≥ code-page-load time.
   - DO NOT click `重新发送电子邮件` (Resend) — on these accounts it crashes `/email-verification` to HTTP 500 / `chrome-error` IMMEDIATELY (input gone, `url=null`), 100% reproducible. The auto-send on page load IS indexed by ichzl; just poll.
   - typeText the code into `input[name="code"]` → `requestSubmit`. A correct code on a healthy account transitions to the consent/callback page (then run `flow-opencodex-consent.mjs` for OpenCodex). `account_deactivated` surfaces on the SAME `/email-verification` URL right after a correct code is accepted (body contains `account_deactivated` / `账户已被删除或停用`) — it is terminal; the login itself succeeded, so do not treat it as a login failure or retry.
   - The `email_helper_url` Base cell reads back as a Markdown link `[label](url)`; take the URL inside the parentheses. ichzl tokens appear to persist per-mailbox; a fresh code arrives within seconds of page load.

## Flow A: Provider Document Parsing
34. **Base record lookup for queued accounts uses `credentials.email`, never `name`**: When matching a sub2api account to its Feishu Base record, always use the `credentials.email` field from `admin get --id <N> --raw` — never the sub2api `name` field. Auto-generated accounts may have an arbitrary sub2api display name that does not match the Base `email` column; the OAuth credentials `email` field is the canonical identifier. If `credentials.email` matches no Base record either, mark the account `manual_required` with a redacted diagnostic (proven 2026-08-10: display-name lookup missed real matches; `credentials.email` resolved them immediately).

Triggered when user provides screenshots or text of provider delivery pages.

See `references/provider-parse-rules.md` for detailed parsing rules.

### Steps

1. Receive direct copied text and/or screenshots from the user. Treat each `=== 使用说明 ===` / `=== 卡密内容 ===` pair as an independent pack and identify it as GPT or SIM without borrowing values from another pack.
2. Extract and structurally validate data following provider-parse-rules.md. For direct-copy text, preserve credential characters exactly and do not run visual/OCR validation. For values extracted only from screenshots, run the mandatory two independent visual reads.
3. Use direct text for secrets and row identifiers. Use an accompanying order screenshot/page only to fill missing provider, order number, stated quantity, and order timestamp; screenshot-only critical strings must satisfy the two-read rule. Do not infer missing metadata from a URL host, the current date, paste/import time, another pack, a previous order, or reference examples.
4. If metadata remains missing, show it as missing and ask one compact follow-up. For SIM order timestamp: when the pasted text does not contain an order creation time and no accompanying screenshot provides one, use the current time as a conservative fallback (`valid_until = now + 30 days`). This underestimates actual validity but never overestimates it. If the user later provides an order screenshot with a visible timestamp, update `valid_until` accordingly.
5. Before create, detect duplicates within the incoming batch and against current Base records using only the minimum identifier fields needed. Keep credential fields silent. Do not create or batch-create until duplicate results are resolved.
6. Require observed live-response evidence before classifying an MFA or SMS URL as `网页` or `API`; never infer type from URL shape. When live evidence is absent at write time, set the type field to `unknown` (or leave it empty if the schema does not support `unknown`). The agent will probe the platform type during the first authorization attempt and update the field then. Missing type evidence does not block the write or auto-execution.
7. Echo the redacted structured preview specified in provider-parse-rules.md. Keep exact parsed values out of output. The preview must expose every blocker. If blockers remain, stop and ask for the missing evidence. If no blockers remain, proceed directly to step 8 without asking for confirmation.
8. Write to Feishu Base:
   - GPT accounts: `lark-cli base +record-batch-create --base-token "<base_token>" --table-id "<gpt_accounts_table_id>" --json '{"fields":["email","password","source_order","source_provider","mfa_platform_url","mfa_platform_type","email_helper_url","sub2api_status"],"rows":[["<email>","<password>","<order>","<provider>","<mfa-url>","<网页-or-API-or-unknown>","<email-helper-or-null>","pending"]]}' --as user`
   - SIM cards: `lark-cli base +record-batch-create --base-token "<base_token>" --table-id "<sim_cards_table_id>" --json '{"fields":["phone_number","sms_url","sms_type","source_order","bound_accounts","bind_count","cooldown_until","valid_until","status"],"rows":[["<phone>","<sms-url>","<网页-or-API-or-unknown>","<order>",null,0,null,"<YYYY-MM-DD HH:mm:ss>","available"]]}' --as user`
   - Batch payloads always use the current `{"fields":[...],"rows":[...]}` shape. Keep row order aligned with `fields`, use `null` for empty cells, and split batches above 200 rows.
   - Set `sub2api_status` to `pending` for new GPT accounts.
   - Set `status` to `available`, `bind_count` to 0, `valid_until` to the verified order-creation timestamp plus the stated validity upper bound (30 days for the observed 25–30 day contract; or `now + 30 days` when using the conservative fallback) for new SIM cards.
   - Per-account MFA delivery: when each account row carries its own TOTP seed (e.g. `邮箱———密码：X———2fa密钥：Y———取码网址`), write the seed into `mfa_secret` and the labeled 取码网址 into `mfa_platform_url` (`mfa_platform_type=unknown` until live-probed). Shared-password packs leave `mfa_secret` empty.
   - Redemption-code SIM delivery (e.g. `chongpt.xyz`): rows carry a redeem code, not a phone number. Write `redeem_code`, `redeem_url` (the 兑换地址 from 使用说明), `channel=chongpt`, `phone_number`/`sms_url` empty, `sms_type=unknown`, and compute `valid_until` from the stated validity lower bound (`now + 25 days` for a stated 25–29 day contract) because the validity clock is not observed until redemption; correct it from the live page after redemption.
   - All Base datetime CellValues use `YYYY-MM-DD HH:mm:ss`.
9. Read back every written record by record_id to confirm field values match.
10. Auto-execute:
    - For GPT accounts: immediately transition each to `authorizing` and start Flow B per account, in the order they appear in the paste.
    - For SIM cards: after readback, query all accounts with `sub2api_status=waiting_sim`, sorted by `waiting_since` ascending, and resume each via Flow D.
    - If the paste contains both types: write all first, then execute GPT authorization, then resume waiting accounts.
    - Report progress after each account. After all accounts are processed, present the summary (see Flow B Summary section).

## Flow B: New Account Authorization

Triggered automatically after Flow A writes GPT accounts (standing authorization), or when user says "authorize", "授权", "开始授权", or when Flow D resumes a `waiting_sim` account.

### Per-Account Steps

For each account with `sub2api_status=pending` (or user-specified emails):

1. **Read credentials from Feishu Base**:
   ```bash
   ACCOUNT_JSON="$(
     lark-cli base +record-list --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" \
       --filter-json '{"logic":"and","conditions":[["email","==","<email>"]]}' \
       --field-id email --field-id password --field-id mfa_platform_url --field-id email_helper_url \
       --field-id bound_phone --field-id sub2api_status --limit 2 --format json --as user
   )"
   ```
   Keep `ACCOUNT_JSON` process-local and do not print it. Require exactly one match, retain the returned GPT `record_id`, and use that exact ID for every later update. If zero or multiple rows match, stop instead of guessing.
   Before using any URL-valued cell in the browser, apply Hard Rule 12. Do not take the first `https://` substring from a Markdown link because it may include Markdown punctuation.

2. **Create ego-browser task space**:
   ```
   ego-browser nodejs <<'EOF'
   const task = await useOrCreateTaskSpace('sub2api auth account-<batch-index>')
   cliLog(JSON.stringify({ taskSpaceId: task.id }))
   EOF
   ```
   Persist the returned numeric `taskSpaceId` in the running task context and reuse it for every later heredoc. An ordinary later heredoc begins with `useOrCreateTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`. Task-space names must not contain a full email address, password, token, or secret-bearing URL.

3. **Login to sub2api and generate auth URL**:
Generate the authorization URL through the admin API (no panel login needed):
```bash
AUTH_RESULT="$(node skills/sub2api-auth/src/sub2api-admin-api.mjs generate-auth-url $( [ -n "$PROXY_ID" ] && echo "--proxy-id $PROXY_ID" ) --raw)"
```
Parse `AUTH_URL` and `SESSION_ID` from the `--raw` JSON into process-local variables (never echo `AUTH_URL`). The backend embeds `redirect_uri=http://localhost:1455/auth/callback`, PKCE `code_challenge`, and `state`; the matching `code_verifier`+`state` live in the session keyed by `SESSION_ID`. Keep `SESSION_ID` for step 7. See `references/sub2api-admin-api.md`.
Panel UI fallback only if the API is unreachable (Hard Rule 20): follow `references/known-ui-patterns.md` → "sub2api Admin — Login"/"Generate Auth URL".

4. **Open auth URL and login to OpenAI**:
   Prefer `scripts/flow-login.mjs <record_id> <space_id> <auth_file.json>` (Reusable Scripts). Fallback by hand: follow `references/known-ui-patterns.md` → "OpenAI OAuth — Login Page".

5. **Handle verification** (observe-act-verify):
   After password submission, `snapshotText()` to determine what OpenAI requires:

   - **MFA / authenticator code page** (code input visible, or OpenAI offers both authenticator and email methods):
     Prefer `scripts/flow-mfa.mjs <record_id> <space_id> [platform_url]` for email-keyed platforms (Reusable Scripts). Otherwise prefer MFA over email OTP whenever an authenticator/MFA challenge is available (see Hard Rule 17). If the account has `mfa_platform_url`, use it. If `mfa_platform_url` is empty but OpenAI shows an authenticator/TOTP option, run the `2fa.nloop.cc` lookup API for the target Base email before choosing email OTP. Follow `references/known-ui-patterns.md` → "OpenAI OAuth — MFA Verification" and `references/nloop-mfa-api.md`. Only fall back to email OTP when the MFA platform reports no result, multiple ambiguous results, or is unreachable.
     When the account has a non-empty `mfa_secret`, the platform is secret-keyed: open `mfa_platform_url` (default `https://2fa.run/`, backups from the account notes), paste the `mfa_secret` seed, and read the current 6-digit TOTP code (follow `references/known-ui-patterns.md` → "MFA Platform — 2fa.run (TOTP Secret Input)"). If the platform page fails, compute TOTP locally from `mfa_secret` instead of falling back to email OTP.

   - **Email verification page** (fallback when MFA unavailable):
     Use email OTP only after MFA is unavailable or failed. For iCloud mailboxes, the observed `email.nloop.cc` import format is the bare email address (not `email----password`). If the helper stays at “点击获取邮件” after a real fetch attempt without mail, code, or error, stop and hand off rather than guessing a code.

   - **Never drive OpenAI auth steps from outside the app's own flow**: Do not call `/api/accounts/authorize/continue` (or any auth-step endpoint) via standalone `fetch`/`js()` and then hard-navigate to the next page. A 2026-08-03 controlled probe proved this forks the server-side login-flow state: the email step returns `200 login_password`, but every subsequent `/api/accounts/password/verify` fails with `401 invalid_username_or_password` even when the submitted password is byte-exact (checksum-verified). Always let the page's own React flow perform each step (fill input → click the real Continue control); recover from errors by restarting the flow fresh instead.

   - **Phone binding page** (phone number input or "Check your phone" text):
     Follow Flow B step 6 below.

   - **Consent page** (Continue/Allow/Authorize button):
     Follow `references/known-ui-patterns.md` → "OpenAI OAuth — Consent Page".

   - **Inherited account chooser** ("选择一个帐户" / "Choose an account"):
     Treat the displayed session as untrusted. If the provider-visible account does not exactly match the target Base email, click `登录至另一个帐户` / `Log in to another account` and authenticate the target account. Do not select the previous account merely because the task space is new. Allow one fresh target-login attempt; if the chooser or consent page still shows another identity, stop without consuming or submitting a callback.

   - **Callback redirect or callback error page**:
     If the current URL is localhost/`127.0.0.1`, retain it silently and proceed to step 7. If Chromium renders an error page and the original callback is no longer exposed by `pageInfo()`, call CDP `Page.getNavigationHistory`, recover exactly one original localhost/`127.0.0.1` callback entry, validate its expected path and query-key shape without logging it, then proceed to step 7.

   - **CAPTCHA / Cloudflare challenge**:
     Follow `references/known-ui-patterns.md` → "CAPTCHA & Cloudflare Automation". The agent attempts all automated resolution (click checkbox, wait for JS challenge, visual model solves image challenge) before considering handoff. Max 3 rounds for Cloudflare interstitial, max 2 rounds for image CAPTCHA. Only after all rounds fail does the agent call `handOffTaskSpace`.

   - **Email mismatch on consent page**:
     Do not click Continue. If the consent/authorization page displays an email that does not exactly match the target account email from Base, the agent automatically logs out of OpenAI (click logout/sign-out), returns to the login page, and re-enters the correct credentials from Base. Max 1 fresh-login retry; if logout does not return to a login page, call `handOffTaskSpace`. If the identity still mismatches, stop without submitting the callback or writing success state.

   - **Account deactivated** (`account_deactivated` text on page after password submission):
     The OpenAI account has been deactivated by OpenAI. Do not retry. Mark the Base record `sub2api_status=failed` with notes `account_deactivated confirmed (<date>)`. Delete via API: `node skills/sub2api-auth/src/sub2api-admin-api.mjs delete --id "$ACCOUNT_ID"`, then read back (`verify` must report absence). Continue to the next account.

   - **Unknown page**:
     `captureScreenshot()`, analyze with visual model to understand page layout, locate inputs/buttons, and determine the next action. Act on the visual model's guidance, then screenshot to verify. Max 2 safe attempt rounds. If still stuck after 2 rounds, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, emit only the returned `{done, skipped}` state, and ask the user for help only when `done === true`. If handoff is skipped, report the ownership state without claiming control was transferred.

   - **User-control or ownership error**:
     Stop the whole browser task immediately. Do not retry, open an alternate task space, or continue through another browser. Resume only after explicit user confirmation, using the exact ownership branch in Hard Rule 11.

6. **Phone binding** (if required):
   Follow `references/known-ui-patterns.md` → "OpenAI OAuth — Phone Binding".
   SIM pool selection logic:
   - Query only the required SIM fields from Feishu Base with `+record-list --field-id phone_number --field-id sms_url --field-id sms_type --field-id channel --field-id redeem_url --field-id bound_accounts --field-id bind_count --field-id last_bind_time --field-id cooldown_until --field-id valid_until --field-id status --field-id notes --format json`, retaining each candidate's `record_id`; keep raw secret-bearing rows out of stdout. Do not project `redeem_code` in selection listings; re-read it process-local by exact `record_id` only for the single row you are about to redeem.
   - Reconcile `status=cooldown` records whose `cooldown_until <= now` back to `available` with `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_SIM_CARDS" --record-id "<sim-record-id>" --json '{"status":"available"}' --as user`, then read back the record
   - Mark records with `bind_count >= 3` as `exhausted` and expired records as `expired` with the same complete command shape, their real `record_id`, and the appropriate status field map, then read them back
   - Filter: status=available, valid_until > now, cooldown_until is empty or <= now, bind_count < 3
   - Exclude phones already tried this round
   - Sort by bind_count ascending, pick first
   - Redemption-code rows: a selected row with `channel=chongpt` and an empty `phone_number` has not been redeemed yet. Follow `references/known-ui-patterns.md` → "SMS Platform — chongpt.xyz (Redemption-Code Channel)" to redeem it, then write the observed `phone_number` (and any observed per-number page/URL) back to that exact SIM record before phone entry. A redemption-code row is only eligible if `redeem_url` is present and `valid_until > now`. If redemption observably fails (invalid/expired code), set that row `status=unavailable` with a redacted diagnostic in `notes`, read back, and pick the next candidate.
   - If none available: fall back to `cooldown` rows before giving up (standing user policy 2026-08-06). OpenAI does not always enforce its post-bind cooldown (accepted a cooldown number on 2026-08-04), so cooldown rows are real candidates, not dead rows. Select them by `bind_count` ascending, then shortest remaining `cooldown_until` first; keep the same per-number handling from the Error Recovery table ("recently used" → `cooldown_until=now+1h` and next number; permanent max-linked rejection → `exhausted`; success → normal bind bookkeeping). Only when NEITHER `available` NOR `cooldown` rows are eligible (all expired/exhausted): update the GPT record to `sub2api_status=waiting_sim` and `waiting_since=<YYYY-MM-DD HH:mm:ss>`, read back, close the task space (step 9), then stop the batch and report. Do not start subsequent accounts of the same batch on a truly empty SIM pool — same-product accounts will hit the same phone-binding wall, and starting them only burns logins and MFA codes (user correction 2026-08-04). Do not mark `manual_required` for recoverable inventory shortage.

7. **Fill callback URL in sub2api**:
Prefer `scripts/flow-consent.mjs <record_id> <space_id> --mode create --session-id <sid>` — identity gate, consent click, callback capture (URL or CDP nav history), and `create` in one call; then run `scripts/repair-mapping.mjs <new_account_id>` (create carries no model_mapping). Manual equivalent: create the account through the admin API from the captured callback:
```bash
# CALLBACK_URL captured in step 5/6 carries ?code=...&state=...
# exchange-code consumes SESSION_ID from step 3, then accounts.create builds the row.
node skills/sub2api-auth/src/sub2api-admin-api.mjs create \
  --name "<email>" --session-id "$SESSION_ID" --code "$CODE" --state "$STATE" \
  $( [ -n "$PROXY_ID" ] && echo "--proxy-id $PROXY_ID" ) \
  --group-ids "$GROUP_ID" --concurrency 3 --raw
```
`create` runs `exchange-code` → `buildCredentials` → `POST /api/v1/admin/accounts` in one call and returns the new account object. Keep the returned account `id` for verification. Then verify against Hard Rule 16 using the API:
```bash
node skills/sub2api-auth/src/sub2api-admin-api.mjs verify --id "$ACCOUNT_ID"
node skills/sub2api-auth/src/sub2api-admin-api.mjs test --id "$ACCOUNT_ID"
```
Require exactly one row whose backend credential `email` matches the target Base email; `has_access_token=true`; `has_refresh_token=true`; current credential metadata; `status=active`; `schedulable=true`; empty `error`; `has_model_mapping` intact (or re-attach via Hard Rule 19 if dropped); and a `test` result with `ok=true` / `test_complete success=true`. A row name, toast, or callback acceptance alone is insufficient. If any identity, credential, test, status, or scheduling check fails and identity is proven wrong, delete the mismatched row (`... delete --id "$ACCOUNT_ID"`), read back its absence (`... verify`), and do not mark the Base account active. The panel "Fill Callback URL" dialog is the fallback only when the API is unreachable (Hard Rule 20).

8. **Update Feishu Base**:
   - GPT update shape: `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --record-id "<gpt-record-id>" --json '<field-map>' --as user`.
   - SIM update shape: `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_SIM_CARDS" --record-id "<sim-record-id>" --json '<field-map>' --as user`.
   - `+record-upsert` without `--record-id` creates a new row and must not be used for updates.
   - Initial authorization success: update the GPT record to `sub2api_status=active` and `auth_time=<YYYY-MM-DD HH:mm:ss>`. **When this run completed a new phone binding, the same `+record-upsert` call MUST also include `bound_phone=<national number>` (Hard Rule 21)**; the post-write readback MUST confirm `bound_phone` is non-empty and matches the just-bound number before reporting success. When no new phone binding was performed, leave `bound_phone` to whatever the readback observes (typically empty).
   - Re-authorization success: update the GPT record to `sub2api_status=active` and `last_reauth_time=<YYYY-MM-DD HH:mm:ss>`. Preserve the existing `bound_phone` unless this run completed a new phone binding.
   - If OpenAI proceeds from MFA directly to consent/callback without phone verification, do not update the SIM row, do not increment `bind_count`, and do not create a cooldown. `bound_phone` remains whatever the readback observes (Hard Rule 21).
   - Successful phone binding: re-read the exact SIM record, compute the complete field map from those observed values, perform one `+record-upsert`, then read back. Increment `bind_count`, set `last_bind_time=<YYYY-MM-DD HH:mm:ss>`, set `cooldown_until=<now + 3 days>` in the same format, append the email to `bound_accounts`, and set `status=cooldown` unless the new bind count is 3, in which case set `status=exhausted`. Do not claim concurrency-safe atomic increment.
   - "Recently used" rejection: update only `status=cooldown`, `cooldown_until=<now + 1 hour>`, and the real SIM field `notes` with a redacted diagnostic. Do not increment `bind_count`, `last_bind_time`, or `bound_accounts`. Read back projected `status`, `cooldown_until`, `notes`, `bind_count`, `last_bind_time`, and `bound_accounts`; require the three binding fields to equal their pre-write values.
   - Failure: update the GPT record to `sub2api_status=failed` or `manual_required` and append a redacted error to `notes`.
   - No eligible SIM at phone binding: update the GPT record to `sub2api_status=waiting_sim` and `waiting_since=<YYYY-MM-DD HH:mm:ss>`. Read back both fields.
   - Read back every updated record with a projection of the exact retained `record_id`; use the email/phone filter only as an additional uniqueness check when needed. Poll until the expected field values match or a bounded timeout expires. Require exactly one match and do not project password or secret-bearing URL fields.

9. **Complete task space**:
   Run this as its own dedicated final heredoc only after a prior heredoc has verified that the browser portion is genuinely complete. Use the numeric ID retained from step 2; the `task` variable does not survive between heredocs.
   ```
   ego-browser nodejs <<'EOF'
   const result = await completeTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>, { keep: false })
   cliLog(JSON.stringify(result))
   EOF
   ```
   Confirm `result.done === true` before reporting cleanup as complete.

10. **Report progress** to user after each account.

### Summary

After all accounts processed, present summary:

```
Authorization Summary
=====================
OK       e***1@example.com    active
WAITING  e***2@example.com    waiting_sim (no eligible SIM)
OK       e***3@example.com    active
MANUAL   e***4@example.com    manual_required (CAPTCHA exhausted)

Total: 4, active: 2, waiting_sim: 1, manual_required: 1
```

If `waiting_sim` count > 0, append: "Paste a SIM card order to automatically resume waiting accounts."

## Flow C: Re-authorization

Triggered when user says "重新授权", "check revoked", "reauth", "错误状态", or provides specific emails.

0. **Silent refresh first (admin API, zero user interaction).** Most error/revoked states are a stale access token while the stored `refresh_token` is still valid. Before generating any auth URL, try:
   ```bash
   node skills/sub2api-auth/src/sub2api-admin-api.mjs refresh --id "$ACCOUNT_ID"
   node skills/sub2api-auth/src/sub2api-admin-api.mjs clear-error --id "$ACCOUNT_ID"
   node skills/sub2api-auth/src/sub2api-admin-api.mjs verify --id "$ACCOUNT_ID"
   ```
   `refresh` = `POST /api/v1/admin/accounts/<id>/refresh`: silent token exchange with the stored refresh_token plus upstream enrichment of `plan_type`/`subscription_expires_at` (verified in Go source `AccountHandler.Refresh` → `RefreshTokenWithClientID` → `enrichTokenInfo`). It does NOT clear error state for OpenAI accounts, hence the explicit `clear-error` (which also invalidates the token cache). Then:
   - Refresh OK + `verify` healthy + `credentials.plan_type` still paid → account recovered. Run step 7's onboarded-state checks (schedulable / model_mapping / groups) and finish with an SSE `/test` ending `test_complete success=true`. Update Base `sub2api_status=active`, `last_reauth_time=<now>`, read back. Done — skip the interactive flow entirely.
   - Refresh OK but `plan_type=free` / subscription lapsed → do not reauth; treat as expired: Base `sub2api_status=过期`, delete via API, read back both (same as the expired-scan policy).
   - Refresh fails (`invalid_grant`, 401, revoked refresh_token) → fall through to step 1 (interactive reauth).
   A silent-refresh recovery never needs a SIM card and never touches `bound_phone`.

1. Identify error-state accounts: query Feishu Base for `sub2api_status=revoked` (or specified emails), **and** cross-check sub2api via the API for accounts showing `错误`/revoked status. Base and sub2api may be out of sync; the backend is the live source of truth.
   ```bash
   node skills/sub2api-auth/src/sub2api-admin-api.mjs list --search "<email>"
   ```
   Retain the matching account `id` (require exactly one match) for the reauth apply step.
2. For each account, re-authorize through the admin API (no panel dialog). Generate a fresh auth URL, let the browser complete the OpenAI flow, capture the callback `code`+`state`, then apply the new credentials to the EXISTING account id:
   ```bash
   # 1. generate auth URL + session_id  (step 3 of Flow B)
   # 2. browser: open auth_url, OpenAI login/MFA/phone/consent, capture callback (steps 4-6)
   # 3. apply new credentials to the existing account id
   node skills/sub2api-auth/src/sub2api-admin-api.mjs apply \
     --id "$ACCOUNT_ID" --session-id "$SESSION_ID" --code "$CODE" --state "$STATE" \
     $( [ -n "$PROXY_ID" ] && echo "--proxy-id $PROXY_ID" ) --raw
   ```
   `apply` runs `exchange-code` → `buildCredentials` → `POST /api/v1/admin/accounts/<id>/apply-oauth-credentials`, which merges credentials + extra at the JSONB key level, clears the error, and invalidates the token cache. It does NOT touch `model_mapping`, group bindings, or non-credential settings, so it avoids Hard Rule 19's replace footgun. The panel "重新授权" dialog is the fallback only when the API is unreachable (Hard Rule 20).
   **Live correction (2026-08-04, #167):** the Extra merge is key-level, but the credentials map is replaced wholesale, so a `credentials.model_mapping` stored inside the credentials JSONB IS dropped by `apply` (confirmed: mapping_n=20 before apply, absent in the apply response). After every `apply`, immediately run step 7's model_mapping check and repair (`scripts/repair-mapping.mjs <acct>`); do not assume the mapping survived.
3. Follow Flow B steps 4-10 (OpenAI login through Base update), applying Hard Rules 14 and 15 for password handling. Drive the browser with the Reusable Scripts: `flow-login.mjs`, `flow-mfa.mjs`, then `flow-consent.mjs --mode apply --id <acct> --session-id <sid>`; run `repair-mapping.mjs <acct>` after the apply.
4. Reuse the account's original `bound_phone` only when its real SIM row has `status=available`, `bind_count < 3`, `valid_until > now`, and an empty or expired `cooldown_until`. Otherwise pick from the normal SIM pool. Never reuse `cooldown`, `expired`, `exhausted`, or `unavailable` records.
5. On success, update `sub2api_status` to `active`, set `last_reauth_time` using `YYYY-MM-DD HH:mm:ss`, and read the record back.
6. If OpenAI reports `account_deactivated`, mark the Base record `failed` with deactivation notes, delete the account via API (`node skills/sub2api-auth/src/sub2api-admin-api.mjs delete --id "$ACCOUNT_ID"`), read back both, and continue to the next account. Do not mark `manual_required` for deactivated accounts — they are permanently unrecoverable. The API delete has no modal-overlay hazard (the former panel reauth dialog silently blocked row-level clicks, observed 2026-08-04 on #164/#165).
7. **Post-reauth config verification (onboarded-state check)**: after every successful reauth, verify the account is back to its just-onboarded state, not merely `active`:
   - `schedulable=true` (re-enable via `POST /api/v1/admin/accounts/<id>/schedulable` with `{"schedulable":true}` if the reauth or a manual toggle left it off).
   - `credentials.model_mapping` intact: reauth replaces credentials and can drop the per-account model mapping (observed on account #165, 2026-08-04). A missing mapping makes the gateway silently fall back to a smaller built-in default model list, so requests for mapped models fail routing. Compare against a healthy same-group account or, better, the group's canonical list `groups.models_list_config.models` (enabled) in the sub2api Postgres DB.
   - Repair by `PUT /api/v1/admin/accounts/<id>` — but remember Hard Rule 19: **PUT replaces all non-token credential fields, it does not merge**. Before the repair PUT, GET the account and build one body containing the COMPLETE credential metadata: `{"credentials":{"email":..., "plan_type":..., "client_id":..., "expires_at":..., "model_mapping":{<model>:<model>, ...}, <every other non-empty credential field>}}` (`model_mapping` is the identity map from the canonical list). A `model_mapping`-only PUT wipes `email`, `plan_type`, `client_id`, expiry fields, and upstream identity fields — exactly the incident that damaged 11 accounts on 2026-08-04.
   - After any credentials PUT, read back the full credential metadata just written plus `credentials_status` (access/refresh/id tokens all present) and unchanged `concurrency/priority/rate_multiplier/proxy_id/group_ids`, and finish with an SSE `/test` ending in `test_complete success=true`. If a partial PUT already happened, treat it as an incident: immediately re-PUT the full metadata (tokens survive) and disclose any fields that cannot be recovered from local sources.
   - Do not use `POST /api/v1/admin/accounts/<id>/models/sync-upstream` for OpenAI `oauth` accounts: it returns 400 `Unsupported OpenAI account type for upstream model sync: oauth` (apikey accounts only).

## Flow D: Resume Waiting-SIM Accounts

Triggered automatically after a SIM card order is written and read back in Flow A step 10, or when user says "resume waiting", "继续等待的账号".

1. Query Feishu Base for all accounts with `sub2api_status=waiting_sim`, sorted by `waiting_since` ascending:
   ```bash
   lark-cli base +record-list --base-token "<base_token>" --table-id "<gpt_accounts_table_id>" \
     --filter-json '{"logic":"and","conditions":[["sub2api_status","==","waiting_sim"]]}' \
     --field-id email --field-id sub2api_status --field-id waiting_since --sort-json '[{"field_name":"waiting_since","order":"asc"}]' \
     --format json --as user
   ```
2. If zero results, report "No waiting accounts" and stop.
3. For each account, follow Flow B steps 1–10 (full authorization from scratch; do not attempt to resume an expired browser session).
4. After all waiting accounts are processed, present the summary (same format as Flow B Summary).

## SIM Pool Rules

- Max 3 bindings per phone number (`bind_count < 3`).
- 3-day cooldown after each successful bind (`cooldown_until = last_bind_time + 3 days`).
- 25-30 day validity from purchase (`valid_until`). Expired cards get `status=expired`.
- On "recently used" rejection: `status=cooldown`, `cooldown_until = now + 1 hour`. A later selection pass restores it to `available` after expiry.
- OpenAI per-IP risk-control SMS suppression (Hard Rule 30, proven 2026-08-07): when consecutive phone-binding attempts from the same proxy/IP all fail to deliver any SMS within the 90 s poll window — i.e. the inbox page returns `暂无短信` for the full budget even after `重新发送短信` was clicked — set the affected SIMs `status=cooldown` and `cooldown_until = now + 1 hour`, do NOT increment `bind_count`/`last_bind_time`/`bound_accounts`, and write the diagnostic to `notes`. This is the same shape as "recently used" but is per-IP rather than per-number: the SIM itself is healthy, OpenAI is rate-limiting the auth flow. After the 1 h cooldown the same SIM becomes a valid candidate again.
- Selection priority: lowest `bind_count` first among available cards.
- OpenAI does not always enforce its post-bind cooldown: on 2026-08-04 a chongpt number still inside its 3-day `cooldown_until` window (after a prior successful bind) was accepted again — SMS delivered and the new bind succeeded (sub2api #166). Treat `cooldown_until` as pool hygiene, not an absolute OpenAI-side gate; attempting cooldown rows still requires explicit user policy.
- Permanent number rejection `此电话号码已关联到可关联的最多账户` (max linked accounts reached; observed 2026-08-04 on a Base-`available` sms24.uk number) means the number can never bind again: set `status=exhausted` with `bind_count` unchanged and a dated note. Base `available` status does not protect against this — classify from the live OpenAI response.
- Redemption-code channel (`channel=chongpt`): the row stores a `redeem_code` and `redeem_url` but no phone number until redeemed. The number is assigned at redemption and its real validity (stated 25–29 days) is confirmed then; pre-redemption `valid_until` is a conservative lower-bound estimate. Within validity the platform allows unlimited code fetches and limited number changes — a fresh SMS read after `开始接收`/`再次接收`/`刷新验证码` is normal and does not by itself consume a binding. OpenAI-side limits (`bind_count < 3`, cooldowns, recently-used rejections) still apply to the redeemed number exactly as for direct-channel numbers.
- If no available card: try `cooldown` cards before declaring shortage (standing user policy 2026-08-06) — pick by `bind_count` ascending, then shortest remaining `cooldown_until` first, and handle each OpenAI response per the Error Recovery table. Only when no `available` and no `cooldown` card is eligible does the account get `sub2api_status=waiting_sim` with `waiting_since=<now>`. This is a durable, resumable state — not a terminal failure.

## Error Recovery

| Situation | Action |
|-----------|--------|
| Cloudflare JS challenge | Real Chromium usually passes automatically; wait and re-observe |
| Cloudflare "Verify you are human" checkbox | Auto-click, wait 5–10s, re-observe; max 3 rounds, then handoff |
| Cloudflare full interstitial | Wait 5–10s, re-observe; max 3 rounds, then handoff |
| reCAPTCHA / hCaptcha checkbox | Auto-click via snapshotText or screenshot; if escalated to image challenge, use visual model to identify targets and click them; two independent visual reads must agree; max 2 rounds, then handoff |
| reCAPTCHA v3 / invisible | Score-based; real Chromium usually passes; no extra action |
| MFA platform unreachable | Fallback to email helper; if both fail, mark manual_required |
| `2fa.nloop.cc` lookup API returns `found:false` for the account email AND Base `mfa_secret` field is empty | Before falling back to email OTP, scan the Base `notes` field for a `mfa_secret=XXXX` text entry. Older manual-add accounts stored the TOTP seed inside notes, not in the dedicated field. Extract the seed, sync it to the `mfa_secret` field via `+record-upsert`, then run `flow-totp-local.mjs` to compute RFC 6238 TOTP locally. Proven 2026-08-11 on #162: three wasted hourly attempts and a park were caused by this gap; after notes-to-field sync the local TOTP succeeded on the first try. |
| MFA visual-only page | Screenshot → visual model reads 6-digit code; two reads must agree |
| SMS platform unreachable | Mark SIM unavailable, try next number |
| OpenAI never delivers SMS within 90 s window even after `重新发送短信` click + `cdp('Page.reload')` polling (static SMS inbox like `sms688.cc`) | OpenAI per-IP risk control (Hard Rule 30). Set affected SIMs `status=cooldown`, `cooldown_until=now+1 hour`; do NOT increment `bind_count`/`last_bind_time`/`bound_accounts`. If 1 verified number is exhausted and only `cooldown` cards remain, the account transitions to `waiting_sim` and the same card becomes a valid candidate after the cooldown expires (do not exhaust fresh SIMs on the same IP window) |
| SMS visual-only page | Screenshot → visual model reads code; two reads must agree |
| Exact OpenAI "recently used" rejection | Set SIM `status=cooldown` and `cooldown_until=now+1 hour`; leave `bind_count`, `last_bind_time`, and `bound_accounts` unchanged; read back, then try the next number (max 3 verified numbers) |
| OpenAI "此电话号码已关联到可关联的最多账户" (max linked accounts reached) | Permanent for that number: set SIM `status=exhausted`, leave `bind_count`/`last_bind_time`/`bound_accounts` unchanged, add a dated redacted note, read back, then try the next eligible number |
| Other phone rejection | Handle only according to the observed response; if no evidence-backed transition exists, keep binding fields unchanged and mark the account `manual_required` |
| 3 numbers tried, more available in pool | Continue with remaining eligible numbers |
| 3 numbers tried, pool empty | Set `sub2api_status=waiting_sim`, `waiting_since=now`; close task space; stop the batch and report — do not start later accounts of the batch on an empty pool (user correction 2026-08-04) |
| Email mismatch on consent page | Auto-logout → re-login with correct credentials; max 1 retry; if logout fails, handoff |
| OpenAI offers both authenticator MFA and email OTP | Choose MFA/authenticator first. Use `mfa_platform_url` when present; otherwise try `2fa.nloop.cc` with the target email. Fall back to email OTP only after observed MFA failure. |
| OpenAI account chooser shows another account | Click `登录至另一个帐户` / `Log in to another account`; authenticate the exact target; never select the inherited previous account |
| Callback succeeds but backend identity differs from target Base email | Delete the newly created mismatched Sub2API row, read back absence, keep Base non-active, and restart once in a fresh isolated target-login flow |
| Unknown OpenAI UI | Screenshot → visual model understands layout → act → verify; max 2 rounds, then handoff |
| Feishu Base API error | Report to user, do not proceed (no local cache) |
| ego-browser "user is controlling" after handoff/takeover | Stop the whole task; after explicit confirmation start with `takeOverTaskSpace(<id>)` |
| ego-browser task space inactive/unassigned/user-owned | Stop the whole task; after explicit confirmation list spaces, `claimTaskSpace(<id>)`, list tabs, and switch to the exact target tab |
| Password wrong | First rule out a forked auth-flow state (see Hard Rule 18): restart the flow fresh and retry once with the same Base value before concluding the password is wrong. Only after a clean fresh-flow attempt fails with a correct checksum-verified value, mark account failed and record error in notes |
| `account_deactivated` on OpenAI page | Mark Base `failed` with deactivation notes; delete from sub2api admin; read back both; continue next account. Terminal — do not retry or mark `manual_required` |
| OpenAI sentinel timeout on password form | The sentinel bot-detection iframe blocks native form POST. Use `form.requestSubmit(btn)` via `js()` instead of ego-browser `click()` on the submit button (see Hard Rule 15). If still timing out after 3 rounds, handoff |
| Fresh OAuth URL opens directly on consent after the same isolated task space completed MFA | Reuse `flow-login.mjs` to load the new URL; it reports `CONSENT_READY` without submitting. Then run `flow-consent.mjs` with the new session ID so its identity gate captures the matching callback. Added 2026-08-10 after reauth #158. |
| `2fa.nloop.cc` lookup API returns non-200 or `api_not_ok` | Treat the platform as unreachable for this round: do not guess a code. Retry once after a few seconds; on a second failure fall back per Hard Rule 17 (notes-embedded seed → `flow-totp-local.mjs`, else email OTP when OpenAI offers it). The keyless API contract and error codes are in `references/nloop-mfa-api.md`. Added 2026-08-12 when `flow-mfa.mjs` moved from the browser-UI query to the JSON API. |
| OpenCodex `login-status` reports a non-terminal `oauth_error` after an accepted callback submission | Transient server-side exchange failure, not deactivation: the driver already sanitized local state when reporting `error`. Restart the whole flow fresh (`start` → `flow-login` → MFA → `flow-opencodex-consent`) and retry once before escalating. Proven 2026-08-12: two of four accounts errored on the first accepted submission and succeeded on an identical retry. |
| OpenAI email challenge returns HTTP 200 but `email.nloop.cc/api/icloud/query` returns not-found, or the helper response lacks evidenced delivery-time metadata | Treat the send side as healthy and the receive channel as unavailable. Do not guess helper fields or an OTP. Canonically cancel the pending OpenCodex flow, verify the auth file is zero bytes and the fixed lock is released, keep the account as `reauth_required`, and retry only with an exact-identity receive channel that supplies sufficient metadata. The receive-failure branch is live-verified; successful OTP retrieval/submission is not. |
| `fillInput` doubles password value | ego-browser `fillInput` may append instead of replace on OpenAI password inputs. Use native setter via `js()` and verify `input.value.length` matches expected before submitting (see Hard Rule 14) |
| Partial credentials PUT wiped account metadata | Admin PUT replaces non-token credential fields (Hard Rule 19). Immediately re-PUT the FULL credential metadata (email, plan_type, client_id, expires_at, model_mapping, and every other recoverable non-empty field); access/refresh/id tokens survive. Fields with no local recovery source (`chatgpt_account_id`, `chatgpt_user_id`, `organization_id`, `subscription_expires_at`) stay empty until a later reauth or upstream probe re-populates them — disclose the gap, never invent values |
| OpenAI "Operation timed out" error page | Sentinel/hydration issue on auth.openai.com (Hard Rule 23): click 重试 at most once; if a form step times out again, reopen the authorization URL fresh and redo the flow — the 重试-restored page is half-hydrated and its submissions time out by design. Do NOT fall back to a standalone fetch of `/api/accounts/authorize/continue` (forks login-flow state, proven 2026-08-03). Fresh-load attempts normally succeed immediately (4/4 on 2026-08-05) |
| sub2api SSE `/test` returns `EOF` on chatgpt.com | Transient upstream flakiness (`Request failed: Post .../codex/responses: EOF`), not a credential problem. Wait a few seconds and retry 1–2 times; optionally probe a healthy control account to distinguish upstream vs account issues. Only a repeated non-EOF error (401/invalid token) indicates a real reauth failure |

## Known UI Patterns

See `references/known-ui-patterns.md` for provenance-tagged patterns. Update `screenshot_inferred` to `snapshot_verified` only after observing the live page, and to `live_verified` only after completing the operation with readback.

## Provider Parsing

See `references/provider-parse-rules.md` for parsing rules and echo format.
