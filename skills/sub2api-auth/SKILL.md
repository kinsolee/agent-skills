---
name: sub2api-auth
description: Use when adding OpenAI OAuth accounts to sub2api, re-authorizing revoked accounts, parsing provider delivery docs, or managing SIM card pool for phone verification
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
  - 添加gpt账号
  - 接码
  - 手机号绑定
  - MFA验证码
  - provider文档
  - 卡密
tags:
  - sub2api
  - openai
  - oauth
  - automation
  - auth
  - ego-browser
  - feishu-base
---

# sub2api OpenAI OAuth — Agent Playbook

Agent-driven automation for the full lifecycle of OpenAI OAuth accounts in sub2api. Uses ego-browser for all browser operations, Feishu Base for persistence, and visual models for page understanding.

## Prerequisites

- ego-browser (ego-lite) installed and running
- lark-cli configured with Feishu authentication
- Feishu Base "sub2api-auth" with tables `gpt_accounts` and `sim_cards` (resolved dynamically via lark-cli)
- sub2api admin URL accessible from ego-browser

## Configuration

Resolve at runtime via lark-cli (no .env tokens needed):

1. `lark-cli base +title-resolve --title "sub2api-auth" --as user` → `base_token`
2. `lark-cli base +base-block-list --base-token <base_token> --as user` → table IDs for `gpt_accounts` and `sim_cards`
3. Cache resolved IDs in the running task context for the session.
4. `SUB2API_ADMIN_URL` defaults to `http://<sub2api-host>:8080/admin/accounts`; read from `.env` only if overridden.

## When to Use

- User provides provider delivery screenshots or text (GPT account packs, SIM card packs)
- User wants to add/authorize OpenAI OAuth accounts to sub2api
- User mentions revoked, 401, or error accounts need re-authorization
- User says keywords: "sub2api", "oauth授权", "添加账号", "重新授权", "接码", "MFA"

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
11. **Exact browser ownership branches**: Ordinary later rounds start with `useOrCreateTaskSpace(<numeric-id>)`. After a confirmed handoff or unexpected takeover, resume with `takeOverTaskSpace(<numeric-id>)`. For a confirmed inactive, unassigned, or user-owned space, use `listTaskSpaces()`, `claimTaskSpace(id)`, `listTabs()`, then `switchTab(targetId)`. A user-control error is a hard stop until explicit confirmation.
12. **Normalize Base URL cells before browser use**: A Base URL-style text cell may read back as a Markdown link such as `[label](https://...)`. For recognized Markdown-link cells, prefer the URL inside the parentheses; otherwise retain the raw value. Validate the normalized scheme and expected origin/shape, keep it process-local, and never print it.
13. **Condition-based Base readback**: A successful Base write response is not the completion proof. Poll a projection of the exact record ID until every expected field matches or a bounded timeout expires. A transient stale read must not be reported as either success or permanent failure.

## Flow A: Provider Document Parsing

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
   Follow `references/known-ui-patterns.md` → "sub2api Admin — Login" and "sub2api Admin — Generate Auth URL".
   If ego-browser inherits user session, login may be skipped.

4. **Open auth URL and login to OpenAI**:
   Follow `references/known-ui-patterns.md` → "OpenAI OAuth — Login Page".

5. **Handle verification** (observe-act-verify):
   After password submission, `snapshotText()` to determine what OpenAI requires:

   - **MFA code page** (code input visible + account has mfa_platform_url):
     Follow `references/known-ui-patterns.md` → "OpenAI OAuth — MFA Verification".

   - **Email verification page** (fallback when MFA unavailable):
     Open email helper URL in new tab, import account email, poll for 6-digit code, fill in OpenAI tab.

   - **Phone binding page** (phone number input or "Check your phone" text):
     Follow Flow B step 6 below.

   - **Consent page** (Continue/Allow/Authorize button):
     Follow `references/known-ui-patterns.md` → "OpenAI OAuth — Consent Page".

   - **Callback redirect or callback error page**:
     If the current URL is localhost/`127.0.0.1`, retain it silently and proceed to step 7. If Chromium renders an error page and the original callback is no longer exposed by `pageInfo()`, call CDP `Page.getNavigationHistory`, recover exactly one original localhost/`127.0.0.1` callback entry, validate its expected path and query-key shape without logging it, then proceed to step 7.

   - **CAPTCHA / Cloudflare challenge**:
     Follow `references/known-ui-patterns.md` → "CAPTCHA & Cloudflare Automation". The agent attempts all automated resolution (click checkbox, wait for JS challenge, visual model solves image challenge) before considering handoff. Max 3 rounds for Cloudflare interstitial, max 2 rounds for image CAPTCHA. Only after all rounds fail does the agent call `handOffTaskSpace`.

   - **Email mismatch on consent page**:
     If the consent/authorization page displays an email that does not match the target account email from Base, the agent automatically logs out of OpenAI (click logout/sign-out), returns to the login page, and re-enters the correct credentials from Base. Max 1 retry; if logout does not return to a login page, call `handOffTaskSpace`.

   - **Unknown page**:
     `captureScreenshot()`, analyze with visual model to understand page layout, locate inputs/buttons, and determine the next action. Act on the visual model's guidance, then screenshot to verify. Max 2 safe attempt rounds. If still stuck after 2 rounds, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, emit only the returned `{done, skipped}` state, and ask the user for help only when `done === true`. If handoff is skipped, report the ownership state without claiming control was transferred.

   - **User-control or ownership error**:
     Stop the whole browser task immediately. Do not retry, open an alternate task space, or continue through another browser. Resume only after explicit user confirmation, using the exact ownership branch in Hard Rule 11.

6. **Phone binding** (if required):
   Follow `references/known-ui-patterns.md` → "OpenAI OAuth — Phone Binding".
   SIM pool selection logic:
   - Query only the required SIM fields from Feishu Base with `+record-list --field-id phone_number --field-id sms_url --field-id sms_type --field-id bound_accounts --field-id bind_count --field-id last_bind_time --field-id cooldown_until --field-id valid_until --field-id status --field-id notes --format json`, retaining each candidate's `record_id`; keep raw secret-bearing rows out of stdout
   - Reconcile `status=cooldown` records whose `cooldown_until <= now` back to `available` with `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_SIM_CARDS" --record-id "<sim-record-id>" --json '{"status":"available"}' --as user`, then read back the record
   - Mark records with `bind_count >= 3` as `exhausted` and expired records as `expired` with the same complete command shape, their real `record_id`, and the appropriate status field map, then read them back
   - Filter: status=available, valid_until > now, cooldown_until is empty or <= now, bind_count < 3
   - Exclude phones already tried this round
   - Sort by bind_count ascending, pick first
   - If none available: update the GPT record to `sub2api_status=waiting_sim` and `waiting_since=<YYYY-MM-DD HH:mm:ss>`, read back, close the task space (step 9), and continue to the next account. Do not mark `manual_required` for recoverable inventory shortage.

7. **Fill callback URL in sub2api**:
   Follow `references/known-ui-patterns.md` → "sub2api Admin — Fill Callback URL".
   Before any success write to Feishu Base, read the created account back in sub2api and require exactly one matching row, observed status `正常`, and an empty remark in the edit dialog. If uniqueness, status, or remark is ambiguous or fails, do not mark the Base account active.

8. **Update Feishu Base**:
   - GPT update shape: `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --record-id "<gpt-record-id>" --json '<field-map>' --as user`.
   - SIM update shape: `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_SIM_CARDS" --record-id "<sim-record-id>" --json '<field-map>' --as user`.
   - `+record-upsert` without `--record-id` creates a new row and must not be used for updates.
   - Initial authorization success: update the GPT record to `sub2api_status=active` and `auth_time=<YYYY-MM-DD HH:mm:ss>`. Set `bound_phone=<phone>` only when this run completed a new phone binding.
   - Re-authorization success: update the GPT record to `sub2api_status=active` and `last_reauth_time=<YYYY-MM-DD HH:mm:ss>`. Preserve the existing `bound_phone` unless this run completed a new phone binding.
   - If OpenAI proceeds from MFA directly to consent/callback without phone verification, do not update the SIM row, do not increment `bind_count`, and do not create a cooldown.
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

Triggered when user says "重新授权", "check revoked", "reauth", or provides specific emails.

1. Query Feishu Base for accounts with `sub2api_status=revoked` (or specified emails).
2. For each account, follow Flow B steps 1-10.
3. Reuse the account's original `bound_phone` only when its real SIM row has `status=available`, `bind_count < 3`, `valid_until > now`, and an empty or expired `cooldown_until`. Otherwise pick from the normal SIM pool. Never reuse `cooldown`, `expired`, `exhausted`, or `unavailable` records.
4. On success, update `sub2api_status` to `active`, set `last_reauth_time` using `YYYY-MM-DD HH:mm:ss`, and read the record back.

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
- Selection priority: lowest `bind_count` first among available cards.
- If no available card: account gets `sub2api_status=waiting_sim` with `waiting_since=<now>`. This is a durable, resumable state — not a terminal failure.

## Error Recovery

| Situation | Action |
|-----------|--------|
| Cloudflare JS challenge | Real Chromium usually passes automatically; wait and re-observe |
| Cloudflare "Verify you are human" checkbox | Auto-click, wait 5–10s, re-observe; max 3 rounds, then handoff |
| Cloudflare full interstitial | Wait 5–10s, re-observe; max 3 rounds, then handoff |
| reCAPTCHA / hCaptcha checkbox | Auto-click via snapshotText or screenshot; if escalated to image challenge, use visual model to identify targets and click them; two independent visual reads must agree; max 2 rounds, then handoff |
| reCAPTCHA v3 / invisible | Score-based; real Chromium usually passes; no extra action |
| MFA platform unreachable | Fallback to email helper; if both fail, mark manual_required |
| MFA visual-only page | Screenshot → visual model reads 6-digit code; two reads must agree |
| SMS platform unreachable | Mark SIM unavailable, try next number |
| SMS visual-only page | Screenshot → visual model reads code; two reads must agree |
| Exact OpenAI "recently used" rejection | Set SIM `status=cooldown` and `cooldown_until=now+1 hour`; leave `bind_count`, `last_bind_time`, and `bound_accounts` unchanged; read back, then try the next number (max 3 verified numbers) |
| Other phone rejection | Handle only according to the observed response; if no evidence-backed transition exists, keep binding fields unchanged and mark the account `manual_required` |
| 3 numbers tried, more available in pool | Continue with remaining eligible numbers |
| 3 numbers tried, pool empty | Set `sub2api_status=waiting_sim`, `waiting_since=now`; close task space; continue next account |
| Email mismatch on consent page | Auto-logout → re-login with correct credentials; max 1 retry; if logout fails, handoff |
| Unknown OpenAI UI | Screenshot → visual model understands layout → act → verify; max 2 rounds, then handoff |
| Feishu Base API error | Report to user, do not proceed (no local cache) |
| ego-browser "user is controlling" after handoff/takeover | Stop the whole task; after explicit confirmation start with `takeOverTaskSpace(<id>)` |
| ego-browser task space inactive/unassigned/user-owned | Stop the whole task; after explicit confirmation list spaces, `claimTaskSpace(<id>)`, list tabs, and switch to the exact target tab |
| Password wrong | Mark account failed, record error in notes |

## Known UI Patterns

See `references/known-ui-patterns.md` for provenance-tagged patterns. Update `screenshot_inferred` to `snapshot_verified` only after observing the live page, and to `live_verified` only after completing the operation with readback.

## Provider Parsing

See `references/provider-parse-rules.md` for parsing rules and echo format.
