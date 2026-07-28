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
- Feishu Base "sub2api-auth" with tables `gpt_accounts` and `sim_cards` (see .env for tokens)
- sub2api admin URL accessible from ego-browser

## Configuration

Read from `.env` file:

| Variable | Purpose |
|----------|---------|
| `FEISHU_BASE_APP_TOKEN` | Feishu Base app_token |
| `FEISHU_TABLE_GPT_ACCOUNTS` | gpt_accounts table_id |
| `FEISHU_TABLE_SIM_CARDS` | sim_cards table_id |
| `SUB2API_ADMIN_URL` | sub2api admin page URL |

## When to Use

- User provides provider delivery screenshots or text (GPT account packs, SIM card packs)
- User wants to add/authorize OpenAI OAuth accounts to sub2api
- User mentions revoked, 401, or error accounts need re-authorization
- User says keywords: "sub2api", "oauth授权", "添加账号", "重新授权", "接码", "MFA"

## Hard Rules

1. **Dual visual model cross-validation**: Every password, key, URL, or token extracted from screenshots must be read by two visual models independently. Adopt only if both agree. If they disagree, ask the user.
2. **Redacted echo before write**: After parsing provider docs, echo a structurally complete preview with counts and one masked row per parsed item. Mask passwords, MFA material, tokens, full email addresses, full phone numbers, and secret-bearing URLs. Wait for explicit confirmation before writing to Feishu Base or starting authorization.
3. **HTML entity provenance**: Keep screenshot OCR raw. Decode entities only for values proven to come from HTML source/DOM text, using standards-compliant decoding.
4. **Redact in all output**: Never show full passwords, tokens, MFA secrets, emails, phone numbers, authorization URLs, callback URLs, or token-bearing URLs in stdout, `cliLog`, commentary, progress reports, errors, cleanup messages, or final output. Use `***` masking and show only non-secret URL origins when useful.
5. **No local credential cache**: Feishu Base is the single source of truth.
6. **sub2api remark field**: Leave empty. Do not store credentials there.
7. **ego-browser task space isolation**: Each account authorization uses its own task space. Complete it when done.
8. **Observe-act-verify loop**: Every browser action follows: snapshotText/screenshot → reason → act → snapshotText/screenshot to verify.
9. **Check known-ui-patterns.md first**: Read the evidence status before using a pattern. Treat `screenshot_inferred` as a hypothesis, `snapshot_verified` as observed structure only, and `live_verified` as a completed path. After successful live observation or end-to-end completion, update provenance and promote the status only to the level actually proven.
10. **Sensitive Base reads stay silent**: Use `--field-id` projections for only the fields needed by the current step. Capture credential-bearing JSON into a process-local variable and do not let the raw row reach stdout, `cliLog`, commentary, or final output. Do not persist it to local JSON/temp files.
11. **Exact browser ownership branches**: Ordinary later rounds start with `useOrCreateTaskSpace(<numeric-id>)`. After a confirmed handoff or unexpected takeover, resume with `takeOverTaskSpace(<numeric-id>)`. For a confirmed inactive, unassigned, or user-owned space, use `listTaskSpaces()`, `claimTaskSpace(id)`, `listTabs()`, then `switchTab(targetId)`. A user-control error is a hard stop until explicit confirmation.

## Flow A: Provider Document Parsing

Triggered when user provides screenshots or text of provider delivery pages.

See `references/provider-parse-rules.md` for detailed parsing rules.

### Steps

1. Receive screenshots/text from user.
2. For each screenshot, identify pack type: GPT account pack or SIM card pack.
3. Extract structured data following provider-parse-rules.md.
4. Run dual visual model cross-validation on all critical strings (passwords, URLs, tokens).
5. Echo the redacted structured preview specified in provider-parse-rules.md. Keep exact parsed values out of output.
6. Wait for user confirmation.
7. On confirmation, write to Feishu Base:
   - GPT accounts: `lark-cli base +record-batch-create --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --json '{"fields":["email","password","source_order","source_provider","mfa_platform_url","mfa_platform_type","email_helper_url","sub2api_status"],"rows":[["<email>","<password>","<order>","<provider>","<mfa-url>","<网页-or-API>","<email-helper-or-null>","pending"]]}' --as user`
   - SIM cards: `lark-cli base +record-batch-create --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_SIM_CARDS" --json '{"fields":["phone_number","sms_url","sms_type","source_order","bound_accounts","bind_count","cooldown_until","valid_until","status"],"rows":[["<phone>","<sms-url>","<网页-or-API-or-unknown>","<order>",null,0,null,"<YYYY-MM-DD HH:mm:ss>","available"]]}' --as user`
   - Batch payloads always use the current `{"fields":[...],"rows":[...]}` shape. Keep row order aligned with `fields`, use `null` for empty cells, and split batches above 200 rows.
   - Set `sub2api_status` to `pending` for new GPT accounts.
   - Set `status` to `available`, `bind_count` to 0, `valid_until` to order_date + 30 days for new SIM cards.
   - All Base datetime CellValues use `YYYY-MM-DD HH:mm:ss`.
8. Report to user: "X accounts and Y SIM cards written to Feishu Base. Ready to authorize?"

## Flow B: New Account Authorization

Triggered when user says "authorize", "授权", "开始授权", or confirms after Flow A.

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

   - **Callback redirect** (URL is localhost/127.0.0.1):
     Extract callback URL, proceed to step 7.

   - **Unknown page**:
     `captureScreenshot()`, analyze with visual model, attempt to proceed. If stuck after 2 attempts, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, emit only the returned `{done, skipped}` state, and ask the user for help only when `done === true`. If handoff is skipped, report the ownership state without claiming control was transferred.

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
   - If none available: mark account `manual_required`, skip to step 8

7. **Fill callback URL in sub2api**:
   Follow `references/known-ui-patterns.md` → "sub2api Admin — Fill Callback URL".
   Before any success write to Feishu Base, read the account back in sub2api, require Active/normal status, and verify the remark is empty. If either check fails or is ambiguous, do not mark the Base account active.

8. **Update Feishu Base**:
   - GPT update shape: `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --record-id "<gpt-record-id>" --json '<field-map>' --as user`.
   - SIM update shape: `lark-cli base +record-upsert --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_SIM_CARDS" --record-id "<sim-record-id>" --json '<field-map>' --as user`.
   - `+record-upsert` without `--record-id` creates a new row and must not be used for updates.
   - Success: update the GPT record to `sub2api_status=active`, `auth_time=<YYYY-MM-DD HH:mm:ss>`, and `bound_phone=<phone>`.
   - Successful phone binding: re-read the exact SIM record, compute the complete field map from those observed values, perform one `+record-upsert`, then read back. Increment `bind_count`, set `last_bind_time=<YYYY-MM-DD HH:mm:ss>`, set `cooldown_until=<now + 3 days>` in the same format, append the email to `bound_accounts`, and set `status=cooldown` unless the new bind count is 3, in which case set `status=exhausted`. Do not claim concurrency-safe atomic increment.
   - "Recently used" rejection: update only `status=cooldown`, `cooldown_until=<now + 1 hour>`, and the real SIM field `notes` with a redacted diagnostic. Do not increment `bind_count`, `last_bind_time`, or `bound_accounts`. Read back projected `status`, `cooldown_until`, `notes`, `bind_count`, `last_bind_time`, and `bound_accounts`; require the three binding fields to equal their pre-write values.
   - Failure: update the GPT record to `sub2api_status=failed` or `manual_required` and append a redacted error to `notes`.
   - Read back every updated record with a projected `+record-list --filter-json '{"logic":"and","conditions":[["email","==","<email>"]]}' --limit 2` or the corresponding phone-number filter before continuing. Require exactly one match and do not project password or secret-bearing URL fields.

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
OK    e***1@example.com    active
FAIL  e***2@example.com    manual_required (no SIM available)
OK    e***3@example.com    active

Total: 3, success: 2, manual_required: 1
```

## Flow C: Re-authorization

Triggered when user says "重新授权", "check revoked", "reauth", or provides specific emails.

1. Query Feishu Base for accounts with `sub2api_status=revoked` (or specified emails).
2. For each account, follow Flow B steps 1-10.
3. Reuse the account's original `bound_phone` only when its real SIM row has `status=available`, `bind_count < 3`, `valid_until > now`, and an empty or expired `cooldown_until`. Otherwise pick from the normal SIM pool. Never reuse `cooldown`, `expired`, `exhausted`, or `unavailable` records.
4. On success, update `sub2api_status` to `active`, set `last_reauth_time` using `YYYY-MM-DD HH:mm:ss`, and read the record back.

## SIM Pool Rules

- Max 3 bindings per phone number (`bind_count < 3`).
- 3-day cooldown after each successful bind (`cooldown_until = last_bind_time + 3 days`).
- 25-30 day validity from purchase (`valid_until`). Expired cards get `status=expired`.
- On "recently used" rejection: `status=cooldown`, `cooldown_until = now + 1 hour`. A later selection pass restores it to `available` after expiry.
- Selection priority: lowest `bind_count` first among available cards.
- If no available card: account gets `sub2api_status=manual_required`.

## Error Recovery

| Situation | Action |
|-----------|--------|
| Cloudflare challenge blocks OpenAI login | Wait 30s with periodic snapshotText; if stuck, handOffTaskSpace for user to solve |
| MFA platform unreachable | Fallback to email helper; if both fail, mark manual_required |
| SMS platform unreachable | Mark SIM unavailable, try next number |
| Exact OpenAI "recently used" rejection | Set SIM `status=cooldown` and `cooldown_until=now+1 hour`; leave `bind_count`, `last_bind_time`, and `bound_accounts` unchanged; read back, then try the next number (max 3 verified numbers) |
| Other phone rejection | Handle only according to the observed response; if no evidence-backed transition exists, keep binding fields unchanged and mark the account `manual_required` |
| No SIM cards available | Mark account manual_required |
| Feishu Base API error | Report to user, do not proceed (no local cache) |
| Unknown OpenAI UI | Screenshot + visual model analysis; attempt operation; handoff if stuck |
| ego-browser "user is controlling" after handoff/takeover | Stop the whole task; after explicit confirmation start with `takeOverTaskSpace(<id>)` |
| ego-browser task space inactive/unassigned/user-owned | Stop the whole task; after explicit confirmation list spaces, `claimTaskSpace(<id>)`, list tabs, and switch to the exact target tab |
| Password wrong | Mark account failed, record error in notes |

## Known UI Patterns

See `references/known-ui-patterns.md` for provenance-tagged patterns. Update `screenshot_inferred` to `snapshot_verified` only after observing the live page, and to `live_verified` only after completing the operation with readback.

## Provider Parsing

See `references/provider-parse-rules.md` for parsing rules and echo format.
