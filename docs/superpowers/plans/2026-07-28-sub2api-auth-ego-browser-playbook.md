# sub2api-auth ego-browser Playbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2905-line Playwright script with an agent-driven playbook using ego-browser, adding MFA auto-fetch, SMS auto-fetch, SIM pool reuse, and Feishu Base persistence.

**Architecture:** Agent reads SKILL.md playbook, uses ego-browser heredocs for all browser automation (sub2api admin, OpenAI OAuth, MFA platforms, SMS platforms), uses lark-cli for Feishu Base CRUD, and uses visual models for page understanding and provider doc parsing. No custom automation scripts — the playbook IS the automation.

**Tech Stack:** ego-browser (ego-lite), lark-cli (lark-base skill), visual models (dual cross-validation), Node.js (only for check_all_ban_status.mjs which is preserved)

## Global Constraints

- All browser automation uses ego-browser heredocs, never Playwright or Puppeteer.
- All Feishu Base operations use `lark-cli base +...` shortcuts per lark-base skill.
- Passwords, tokens, and MFA secrets in agent output must be redacted.
- Provider doc parsing requires dual visual model cross-validation before adoption.
- Parsed results must be echoed to user for confirmation before writing to Feishu Base.
- SIM pool rules: max 3 binds per number, 3-day cooldown after each bind, 25-30 day validity, 1-hour cooldown on recently-used rejection.
- Feishu Base is the single source of truth; no local credential cache.
- sub2api remark field is left empty; no credentials stored there.
- HTML entity decoding required on all parsed strings from provider docs.
- UI patterns must carry provenance and one of these evidence states: `screenshot_inferred`, `snapshot_verified`, or `live_verified`. Never present inferred behavior as live verified.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `skills/sub2api-auth/SKILL.md` | Rewrite | Agent playbook: triggers, provider parsing flow, auth playbook, reauth playbook, SIM rules, config |
| `skills/sub2api-auth/references/provider-parse-rules.md` | Create | Parsing rules for GPT account packs and SIM card packs, derived from real samples |
| `skills/sub2api-auth/references/known-ui-patterns.md` | Create | Provenance-tagged UI hypotheses and verified operation sequences; grows with each successful run |
| `skills/sub2api-auth/.env.example` | Modify | Add Feishu Base env vars, remove Playwright/Camofox vars |
| `skills/sub2api-auth/package.json` | Modify | Remove playwright and camofox-browser dependencies |
| `skills/sub2api-auth/src/authorize-openai-oauth.mjs` | Keep as-is | Deprecated reference only; no modifications |
| `skills/sub2api-auth/check_all_ban_status.mjs` | Keep as-is | Preserved independent tool |

---

### Task 1: Create Feishu Base Tables

**Files:**
- No code files; this task creates remote Feishu Base resources.
- Output: `base_token`, `table_id` for gpt_accounts, `table_id` for sim_cards — recorded in `.env.example` as placeholder comments.

**Interfaces:**
- Produces: Feishu Base with two tables, ready for lark-cli read/write.
- Consumed by: Task 4 (SKILL.md references the table names), Task 6 (e2e test writes/reads).

- [ ] **Step 1: Create the Base with gpt_accounts table**

Run:
```bash
lark-cli base +base-create --name "sub2api-auth" --time-zone Asia/Shanghai --table-name "gpt_accounts" --fields '[
  {"name":"email","type":"text","style":{"type":"email"}},
  {"name":"password","type":"text"},
  {"name":"source_order","type":"text"},
  {"name":"source_provider","type":"text"},
  {"name":"mfa_platform_url","type":"text","style":{"type":"url"}},
  {"name":"mfa_platform_type","type":"select","multiple":false,"options":[{"name":"网页"},{"name":"API"}]},
  {"name":"email_helper_url","type":"text","style":{"type":"url"}},
  {"name":"bound_phone","type":"text"},
  {"name":"sub2api_status","type":"select","multiple":false,"options":[{"name":"pending"},{"name":"active"},{"name":"revoked"},{"name":"banned"},{"name":"failed"},{"name":"manual_required"}]},
  {"name":"auth_time","type":"datetime","style":{"format":"yyyy-MM-dd HH:mm"}},
  {"name":"last_reauth_time","type":"datetime","style":{"format":"yyyy-MM-dd HH:mm"}},
  {"name":"notes","type":"text"}
]' --as user
```

Expected: Returns `base_token` and `table_id` for gpt_accounts. Record both values.

- [ ] **Step 2: Create sim_cards table in the same Base**

Run:
```bash
lark-cli base +table-create --base-token "<BASE_TOKEN>" --name "sim_cards" --fields '[
  {"name":"phone_number","type":"text"},
  {"name":"sms_url","type":"text","style":{"type":"url"}},
  {"name":"sms_type","type":"select","multiple":false,"options":[{"name":"网页"},{"name":"API"},{"name":"unknown"}]},
  {"name":"source_order","type":"text"},
  {"name":"bound_accounts","type":"text"},
  {"name":"bind_count","type":"number","style":{"type":"plain","precision":0,"percentage":false,"thousands_separator":false}},
  {"name":"last_bind_time","type":"datetime","style":{"format":"yyyy-MM-dd HH:mm"}},
  {"name":"cooldown_until","type":"datetime","style":{"format":"yyyy-MM-dd HH:mm"}},
  {"name":"valid_until","type":"datetime","style":{"format":"yyyy-MM-dd HH:mm"}},
  {"name":"status","type":"select","multiple":false,"options":[{"name":"available"},{"name":"cooldown"},{"name":"expired"},{"name":"exhausted"},{"name":"unavailable"}]},
  {"name":"notes","type":"text"}
]' --as user
```

Expected: Returns `table_id` for sim_cards. Record it.

- [ ] **Step 3: Verify tables by listing fields**

Run:
```bash
lark-cli base +field-list --base-token "<BASE_TOKEN>" --table-id "<GPT_TABLE_ID>" --as user
lark-cli base +field-list --base-token "<BASE_TOKEN>" --table-id "<SIM_TABLE_ID>" --as user
```

Expected: Both commands return the field lists matching the schemas defined above.

- [ ] **Step 4: Record tokens in .env (local, gitignored)**

Add to `skills/sub2api-auth/.env`:
```
FEISHU_BASE_APP_TOKEN=<BASE_TOKEN>
FEISHU_TABLE_GPT_ACCOUNTS=<GPT_TABLE_ID>
FEISHU_TABLE_SIM_CARDS=<SIM_TABLE_ID>
```

- [ ] **Step 5: Verify Base and table readback without synthetic business records**

Do not create a fake account such as `test@example.com`. Verify the remote resources using metadata and empty-list reads only:

```bash
lark-cli base +base-get --base-token "<BASE_TOKEN>" --as user
lark-cli base +table-list --base-token "<BASE_TOKEN>" --as user
lark-cli base +record-list --base-token "<BASE_TOKEN>" --table-id "<GPT_TABLE_ID>" --as user
lark-cli base +record-list --base-token "<BASE_TOKEN>" --table-id "<SIM_TABLE_ID>" --as user
```

Expected: Base metadata and both real table IDs read back successfully. Records may be empty. Record CRUD is verified later with confirmed real provider snapshots in Task 6.

---

### Task 2: Write Provider Parse Rules

**Files:**
- Create: `skills/sub2api-auth/references/provider-parse-rules.md`

**Interfaces:**
- Consumed by: SKILL.md playbook (provider parsing section references this file).
- Produces: Documented parsing rules that agent follows when receiving provider screenshots/text.

- [ ] **Step 1: Write provider-parse-rules.md**

Create `skills/sub2api-auth/references/provider-parse-rules.md` with the following content:

```markdown
# Provider Document Parsing Rules

Rules derived from real provider delivery screenshots. Agent follows these when parsing user-provided screenshots or text.

## Dual Visual Model Cross-Validation

1. For every password, secret key, URL, or token string extracted from a screenshot, run two independent visual model reads.
2. If both reads produce identical strings, adopt the result.
3. If they differ, stop and ask the user to confirm the correct value. Do not guess or pick one.
4. After extraction, echo the full structured result to the user and wait for explicit confirmation before writing to Feishu Base.

## HTML Entity Decoding

All strings extracted from screenshots or HTML-rendered pages must be decoded:
- `&#26;` → `&`
- `&#35;` → `#`
- `&#33;` → `!`
- `&amp;` → `&`
- `&lt;` → `<`
- `&gt;` → `>`
- Any `&#NNN;` or `&#xHH;` pattern → corresponding Unicode character

Apply decoding before cross-validation comparison and before echoing to user.

## GPT Account Pack Format

Observed structure (from 链动小铺 order LD26072731CVWM):

- **Card list**: Each card entry contains one email address. Cards are numbered (第1张, 第2张, ...).
- **Password**: Found in "使用说明" section, typically labeled "ChatGPT 登录密码默认：XXX" or "发货格式（Gmail 邮件发货，账户已添加密码和 MFA）（ChatGPT 登录密码默认：XXX）". This is a shared password for all accounts in the pack.
- **MFA platform URL**: Found in "使用说明" section, labeled "MFA 接码地址：URL". Example: `https://2fa.nloop.cc/`
- **Email helper URL**: Sometimes mentioned separately for email verification codes. Example: `https://email.nloop.cc/`
- **Order number**: From "订单号" field. Example: `LD26072731CVWM`
- **Provider name**: From page header or merchant name. Example: "链动小铺"
- **Quantity**: From "数量" field. Must match the number of card entries parsed.

Parsing algorithm:
1. Extract all email addresses from the card list section (look for numbered entries or lines matching email regex).
2. Extract the shared password from the usage instructions.
3. Extract MFA platform URL.
4. Extract email helper URL if present.
5. Extract order number and provider name.
6. Verify: number of emails parsed == quantity stated in order.

## SIM Card Pack Format

Observed structure (from 链动小铺 order LD260727B55K8S):

- **Card list**: Each card entry contains `phone_number|sms_url` or `phone_number----sms_url`. Both `|` and `----` separators must be recognized.
- **Phone number**: Digits only, may include country code prefix. Example: `13103887887`
- **SMS URL**: Full URL including token parameter. Example: `https://sms369.vip/api/sms/access?token=xxx`
- **Order number**: From "订单号" field.
- **Validity**: From usage instructions, typically "有效期25-30天". Parse the upper bound (30 days) as default valid_until offset from order creation date.
- **Quantity**: From "数量" field. Must match number of card entries parsed.

Parsing algorithm:
1. For each card entry, split on `|` first; if no `|` found, split on `----`.
2. Left part = phone_number, right part = sms_url.
3. Extract order number and validity period.
4. Verify: number of entries parsed == quantity stated.

## Multi-Pack Handling

User may provide multiple screenshots in one message (e.g., one GPT pack + one SIM pack, or multiple of each). Parse each independently, then merge all gpt_accounts records and all sim_cards records into single batch writes.

## Echo Format

After parsing, present to user in this format:

```
GPT 账号包（订单 XXXXX，provider: XXX）:
  密码: XXXX
  MFA 平台: XXXX
  邮箱助手: XXXX（如有）
  账号列表:
    1. email1@example.com
    2. email2@example.com
    ...

手机卡包（订单 XXXXX）:
  1. 13103887887 → https://sms369.vip/...
  2. 13104246503 → https://sms369.vip/...
  ...

确认写入飞书 Base？
```
```

- [ ] **Step 2: Commit**

```bash
git add skills/sub2api-auth/references/provider-parse-rules.md
git commit -m "docs: add provider document parsing rules from real samples"
```

---

### Task 3: Write Known UI Patterns (Initial Seed)

**Files:**
- Create: `skills/sub2api-auth/references/known-ui-patterns.md`

**Interfaces:**
- Consumed by: SKILL.md playbook (each step checks this file for known patterns before doing live observation).
- Produces: Seed patterns from user-provided screenshots; grows after each successful run.

- [ ] **Step 1: Write known-ui-patterns.md with seed patterns**

Create `skills/sub2api-auth/references/known-ui-patterns.md`:

```markdown
# Known UI Patterns

This file contains both hypotheses and verified operation sequences. Every pattern must include:

- `evidence_status`: `screenshot_inferred`, `snapshot_verified`, or `live_verified`
- `source`: the screenshot, live page, or historical run that supports it
- `as_of`: exact capture or verification date when known

`screenshot_inferred` is a hypothesis only: observe the live page before acting. `snapshot_verified` means the current page structure was observed but the full operation was not completed. Only `live_verified` means the complete operation and readback succeeded.

## sub2api Admin — Login

Evidence: `live_verified` from historical sub2api automation and operations notes; host changed to `<sub2api-host>`, so take a fresh snapshot before the first current run.

Page: `SUB2API_ADMIN_URL` (default `http://<sub2api-host>:8080/admin/accounts`)

1. `openOrReuseTab(adminUrl, { wait: true })`
2. `snapshotText()` — check if redirected to login page (URL contains `/login`)
3. If login page: find email input (placeholder contains "email"), `fillInput` with admin email
4. Find password input (placeholder contains "password"), `fillInput` with admin password
5. `click` submit button (`button[type="submit"]` or text "Sign In")
6. `snapshotText()` — verify URL no longer contains `/login`

Note: ego-browser may inherit user's login session. If already logged in, skip to step 6.

## sub2api Admin — Generate Auth URL

Evidence: `live_verified` from historical sub2api automation; refresh `as_of` after the first current run.

Prerequisite: logged in, on accounts page.

1. `snapshotText()` — look for "Add Account" or "添加账号" button
2. `click` the add button
3. `snapshotText()` — dialog should appear with platform/group/type selectors
4. Select platform = "OpenAI", group = configured group, account type = "Oauth"
5. Look for proxy selector — pick any real proxy (skip "无代理"/"No Proxy")
6. `click` confirm/add button
7. `snapshotText()` — look for "Generate Auth URL" or "Generate Auth Link" or "生成授权链接" button
8. `click` it
9. `snapshotText()` — look for the authorization URL text or a copy button; extract the URL
10. If URL not visible in snapshot, try `js()` to read from input/textarea value

## sub2api Admin — Fill Callback URL

Evidence: `live_verified` from historical sub2api automation; refresh `as_of` after the first current run.

Prerequisite: account dialog still open, callback URL obtained from OpenAI flow.

1. `snapshotText()` — look for input field labeled "授权链接" or "Code" or "Authorization URL" or "Callback"
2. `fillInput` with the callback URL
3. `click` confirm/submit button
4. `snapshotText()` — verify account status changed or dialog closed

## OpenAI OAuth — Login Page

Evidence: `live_verified` from historical OpenAI OAuth runs; always re-observe because OpenAI UI changes frequently.

Page: authorization URL from sub2api.

1. `openOrReuseTab(authUrl, { wait: true })`
2. Wait 3 seconds for page load and potential Cloudflare challenge
3. `snapshotText()` — check for Cloudflare challenge; if present, wait and retry snapshotText every 3s up to 30s; if still stuck, `handOffTaskSpace` and ask user to solve it
4. Find email input (various selectors: `input[name="username"]`, `input[type="email"]`, etc.) — use snapshotText refs
5. `fillInput` with account email
6. `click` Continue/Next/继续 button
7. Wait 2-3 seconds
8. `snapshotText()` — check if "Continue with password" / "使用密码继续" / "Use password instead" link appeared; if yes, click it
9. Find password input (`input[type="password"]`)
10. `fillInput` with account password
11. `click` Continue/Log in/登录 button
12. Wait 2-3 seconds
13. `snapshotText()` — determine next state (MFA page / email verification / phone binding / consent page / callback redirect)

## OpenAI OAuth — MFA Verification (2fa.nloop.cc)

Evidence: `screenshot_inferred` from user-provided provider instructions on 2026-07-28. Not yet live verified.

Triggered when: snapshotText shows a code input field (`input[name="code"]`, `input[autocomplete="one-time-code"]`, or 6 separate digit inputs) AND the account record has `mfa_platform_url`.

1. Open MFA platform in new tab: `openOrReuseTab(mfaPlatformUrl)`
2. `snapshotText()` — find the email paste input on the right panel (labeled "粘贴邮箱" or has `@` prefix)
3. `fillInput` with the account email
4. Wait 2-3 seconds
5. `snapshotText()` — look for 6-digit code in the results area (large font, next to a countdown timer)
6. If countdown < 5 seconds, wait for next refresh cycle (watch for countdown reset)
7. Extract the 6-digit code
8. Close MFA tab or switch back to OpenAI tab
9. `fillInput` the code into the verification input
10. `click` Continue/Verify/验证 button

Fallback: If MFA platform returns no result for this email, try email helper (email.nloop.cc) using the same multi-tab pattern from the existing script's `retrieveEmailCode` logic.

## OpenAI OAuth — Phone Binding

Evidence: `screenshot_inferred` from user-provided provider instructions on 2026-07-28. Not yet live verified.

Triggered when: snapshotText or screenshot shows "phone number", "Check your phone", "Enter the verification code we just sent to", "添加电话号码", or a phone number input field.

1. Query Feishu Base for available SIM cards (lark-cli)
2. Agent reasoning: pick best phone number per SIM pool rules
3. `snapshotText()` — find phone number input field
4. Observe international code handling: is there a country dropdown? A `+1` prefix field? Handle per actual UI.
5. `fillInput` with phone number
6. `click` Continue / Send code button
7. Wait 3 seconds
8. Open SMS platform URL in new tab: `openOrReuseTab(smsUrl)`
9. Poll loop (every 5s, max 120s):
   a. `snapshotText()` on SMS tab
   b. Look for 4-8 digit verification code in page text
   c. If page shows "无法向此号码发送验证码" or "This phone number was recently used" → return PHONE_REJECTED
   d. If code found → extract and break loop
10. If PHONE_REJECTED: set SIM status to `cooldown`, set `cooldown_until = now + 1 hour`, pick next number, go to step 3 (max 3 retries)
11. If code found: switch to OpenAI tab, `fillInput` code, `click` Continue
12. If 3 retries exhausted: mark account as manual_required

## OpenAI OAuth — Consent Page

Evidence: `live_verified` from historical OpenAI OAuth runs; re-observe on the current run.

Triggered when: snapshotText shows "Continue" / "Allow" / "Authorize" / "授权" / "Accept" buttons and URL is still on openai.com/auth or similar.

1. `click` the consent button
2. Wait 2-3 seconds
3. `snapshotText()` or `pageInfo()` — check if URL redirected to localhost/127.0.0.1 (callback)
4. If callback URL detected, extract it

## SMS Platform — sms369.vip (Web Mode)

Evidence: `screenshot_inferred` from user-provided SIM delivery instructions on 2026-07-28. The response shape is unknown until probed.

Page: token URL like `https://sms369.vip/api/sms/access?token=xxx`

1. `openOrReuseTab(smsUrl)`
2. `snapshotText()` — observe page structure
3. First visit: check Content-Type or page content to determine if API (JSON) or web (HTML)
4. For web mode: look for SMS message text containing verification code
5. For API mode: use `js()` or `browserFetch()` to parse JSON response
6. Extract 4-8 digit code

Note: This pattern needs live verification on first use. After successful extraction, update this section with the actual DOM structure observed.

---

*This file grows after each successful automation run. Agent appends new patterns with date and platform name.*
```

- [ ] **Step 2: Commit**

```bash
git add skills/sub2api-auth/references/known-ui-patterns.md
git commit -m "docs: seed known UI patterns from real screenshots"
```

---

### Task 4: Rewrite SKILL.md Playbook

**Files:**
- Rewrite: `skills/sub2api-auth/SKILL.md`

**Interfaces:**
- Consumes: references/provider-parse-rules.md, references/known-ui-patterns.md, references/local-wsl-operations.md
- Produces: Complete agent playbook that replaces authorize-openai-oauth.mjs as the primary automation entry point.

- [ ] **Step 1: Write the new SKILL.md**

Replace the entire content of `skills/sub2api-auth/SKILL.md` with the following. This is the core deliverable of the project — the agent playbook.

```markdown
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
2. **Echo before write**: After parsing provider docs, echo the full structured result to the user. Wait for explicit confirmation before writing to Feishu Base or starting authorization.
3. **HTML entity decode**: Decode all HTML entities in parsed strings before comparison or storage.
4. **Redact in output**: Never show full passwords, tokens, or MFA secrets in commentary or final output. Use `***` masking.
5. **No local credential cache**: Feishu Base is the single source of truth.
6. **sub2api remark field**: Leave empty. Do not store credentials there.
7. **ego-browser task space isolation**: Each account authorization uses its own task space. Complete it when done.
8. **Observe-act-verify loop**: Every browser action follows: snapshotText/screenshot → reason → act → snapshotText/screenshot to verify.
9. **Check known-ui-patterns.md first**: Read the evidence status before using a pattern. Treat `screenshot_inferred` as a hypothesis, `snapshot_verified` as observed structure only, and `live_verified` as a completed path. After successful live observation or end-to-end completion, update provenance and promote the status only to the level actually proven.

## Flow A: Provider Document Parsing

Triggered when user provides screenshots or text of provider delivery pages.

See `references/provider-parse-rules.md` for detailed parsing rules.

### Steps

1. Receive screenshots/text from user.
2. For each screenshot, identify pack type: GPT account pack or SIM card pack.
3. Extract structured data following provider-parse-rules.md.
4. Run dual visual model cross-validation on all critical strings (passwords, URLs, tokens).
5. Echo structured result to user in the format specified in provider-parse-rules.md.
6. Wait for user confirmation.
7. On confirmation, write to Feishu Base:
   - GPT accounts: `lark-cli base +record-batch-create --base-token $FEISHU_BASE_APP_TOKEN --table-id $FEISHU_TABLE_GPT_ACCOUNTS --records '<json>' --as user`
   - SIM cards: `lark-cli base +record-batch-create --base-token $FEISHU_BASE_APP_TOKEN --table-id $FEISHU_TABLE_SIM_CARDS --records '<json>' --as user`
   - Set `sub2api_status` to `pending` for new GPT accounts.
   - Set `status` to `available`, `bind_count` to 0, `valid_until` to order_date + 30 days for new SIM cards.
8. Report to user: "X accounts and Y SIM cards written to Feishu Base. Ready to authorize?"

## Flow B: New Account Authorization

Triggered when user says "authorize", "授权", "开始授权", or confirms after Flow A.

### Per-Account Steps

For each account with `sub2api_status=pending` (or user-specified emails):

1. **Read credentials from Feishu Base**:
   ```bash
   lark-cli base +record-search --base-token $FEISHU_BASE_APP_TOKEN --table-id $FEISHU_TABLE_GPT_ACCOUNTS --filter '{"conjunction":"and","conditions":[{"field_name":"email","operator":"is","value":["<email>"]}]}' --as user
   ```

2. **Create ego-browser task space**:
   ```
   ego-browser nodejs <<'EOF'
   const task = await useOrCreateTaskSpace('auth <email>')
   cliLog('task space id: ' + task.id)
   EOF
   ```

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
     `captureScreenshot()`, analyze with visual model, attempt to proceed. If stuck after 2 attempts, `handOffTaskSpace` and ask user for help.

6. **Phone binding** (if required):
   Follow `references/known-ui-patterns.md` → "OpenAI OAuth — Phone Binding".
   SIM pool selection logic:
   - Query available SIM cards from Feishu Base
   - Reconcile `status=cooldown` records whose `cooldown_until <= now` back to `available`
   - Filter: status=available, valid_until > now, cooldown_until < now, bind_count < 3
   - Exclude phones already tried this round
   - Sort by bind_count ascending, pick first
   - If none available: mark account `manual_required`, skip to step 8

7. **Fill callback URL in sub2api**:
   Follow `references/known-ui-patterns.md` → "sub2api Admin — Fill Callback URL".

8. **Update Feishu Base**:
   - Success: update `sub2api_status` to `active`, set `auth_time`, set `bound_phone`
   - Update SIM card: increment `bind_count`, set `last_bind_time`, set `cooldown_until` = now + 3 days, append email to `bound_accounts`
   - Failure: update `sub2api_status` to `failed` or `manual_required`, append error to `notes`

9. **Complete task space**:
   ```
   ego-browser nodejs <<'EOF'
   await completeTaskSpace(task.id, { keep: false })
   EOF
   ```

10. **Report progress** to user after each account.

### Summary

After all accounts processed, present summary:

```
Authorization Summary
=====================
OK    email1@example.com    active
FAIL  email2@example.com    manual_required (no SIM available)
OK    email3@example.com    active

Total: 3, success: 2, manual_required: 1
```

## Flow C: Re-authorization

Triggered when user says "重新授权", "check revoked", "reauth", or provides specific emails.

1. Query Feishu Base for accounts with `sub2api_status=revoked` (or specified emails).
2. For each account, follow Flow B steps 1-10.
3. If the account's original `bound_phone` is still available (not in cooldown/expired/unavailable), try reusing it first. Otherwise pick from SIM pool.
4. On success, update `sub2api_status` to `active`, set `last_reauth_time`.

## Flow D: Ban Status Check

Use the preserved `check_all_ban_status.mjs` script for read-only scanning. This script is independent of the playbook and runs via Node.js.

```bash
cd skills/sub2api-auth && node check_all_ban_status.mjs
```

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
| Phone rejected by OpenAI | Mark SIM `cooldown` for 1 hour, try next number (max 3 retries) |
| No SIM cards available | Mark account manual_required |
| Feishu Base API error | Report to user, do not proceed (no local cache) |
| Unknown OpenAI UI | Screenshot + visual model analysis; attempt operation; handoff if stuck |
| ego-browser "user is controlling" | Stop, ask user to confirm continue, then takeOverTaskSpace |
| Password wrong | Mark account failed, record error in notes |

## Known UI Patterns

See `references/known-ui-patterns.md` for provenance-tagged patterns. Update `screenshot_inferred` to `snapshot_verified` only after observing the live page, and to `live_verified` only after completing the operation with readback.

## Provider Parsing

See `references/provider-parse-rules.md` for parsing rules and echo format.

## Operational Notes

See `references/local-wsl-operations.md` for environment-specific details (WSL paths, Docker compose, etc.).
```

- [ ] **Step 2: Verify SKILL.md frontmatter parses correctly**

Run:
```bash
head -20 skills/sub2api-auth/SKILL.md
```

Expected: YAML frontmatter with name, description, triggers, tags is well-formed.

- [ ] **Step 3: Commit**

```bash
git add skills/sub2api-auth/SKILL.md
git commit -m "feat: rewrite SKILL.md as ego-browser agent playbook"
```

---

### Task 5: Update .env.example and Clean Up package.json

**Files:**
- Modify: `skills/sub2api-auth/.env.example`
- Modify: `skills/sub2api-auth/package.json`

**Interfaces:**
- Consumes: Task 1 output (Feishu Base token variable names).
- Produces: Clean dependency manifest and env template for new setup.

- [ ] **Step 1: Rewrite .env.example**

Replace `skills/sub2api-auth/.env.example` with:

```
# Feishu Base (single source of truth for credentials and state)
FEISHU_BASE_APP_TOKEN=
FEISHU_TABLE_GPT_ACCOUNTS=
FEISHU_TABLE_SIM_CARDS=

# sub2api admin (agent operates via ego-browser; URL needed for navigation)
SUB2API_ADMIN_URL=http://<sub2api-host>:8080/admin/accounts
```

- [ ] **Step 2: Simplify package.json**

Remove `playwright` and `@askjo/camofox-browser` from dependencies. Keep only what `check_all_ban_status.mjs` needs (playwright is still used there). Actually, check_all_ban_status.mjs imports playwright, so keep it. Remove only camofox-browser.

Updated `skills/sub2api-auth/package.json`:

```json
{
  "name": "sub2api-auto-auth",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "scripts": {
    "check-ban": "node check_all_ban_status.mjs"
  },
  "dependencies": {
    "playwright": "^1.52.0"
  }
}
```

Note: The `auth` script entry is removed since the main flow is now agent-driven via ego-browser, not `node src/authorize-openai-oauth.mjs`.

- [ ] **Step 3: Commit**

```bash
git add skills/sub2api-auth/.env.example skills/sub2api-auth/package.json
git commit -m "chore: update env template and remove camofox dependency"
```

---

### Task 6: End-to-End Validation

**Files:**
- No new files; this task validates the playbook with a real account.

**Interfaces:**
- Consumes: All previous tasks (Feishu Base tables, SKILL.md playbook, reference docs, env config).
- Produces: Verified playbook + updated known-ui-patterns.md with any new patterns discovered.

**Prerequisites:**
- At least one `pending` account in Feishu Base gpt_accounts table (from a real provider pack parsed via Flow A).
- At least one `available` SIM card in Feishu Base sim_cards table.
- ego-browser running.
- lark-cli authenticated.

- [ ] **Step 1: Verify Feishu Base has test data**

```bash
lark-cli base +record-list --base-token $FEISHU_BASE_APP_TOKEN --table-id $FEISHU_TABLE_GPT_ACCOUNTS --as user
lark-cli base +record-list --base-token $FEISHU_BASE_APP_TOKEN --table-id $FEISHU_TABLE_SIM_CARDS --as user
```

Expected: At least one pending account and one available SIM card.

- [ ] **Step 2: Execute Flow B for one account**

Follow SKILL.md Flow B step by step for the first pending account. At each step:

1. Run the ego-browser heredoc.
2. Observe the result (snapshotText / screenshot).
3. Verify the page is in the expected state.
4. If a step fails or encounters an unknown UI, document what happened.

- [ ] **Step 3: Document any new UI patterns discovered**

For every platform touched, update the pattern provenance with the exact date:

- Promote to `snapshot_verified` if the live structure was observed but the operation did not finish.
- Promote to `live_verified` only if the operation completed and its result was read back.
- If the UI differs, replace the inferred steps with the observed steps while retaining the old evidence note as history.

- [ ] **Step 4: Verify Feishu Base state after authorization**

```bash
lark-cli base +record-search --base-token $FEISHU_BASE_APP_TOKEN --table-id $FEISHU_TABLE_GPT_ACCOUNTS --filter '{"conjunction":"and","conditions":[{"field_name":"email","operator":"is","value":["<test-email>"]}]}' --as user
```

Expected: `sub2api_status` = `active`, `auth_time` is set, `bound_phone` is set.

```bash
lark-cli base +record-search --base-token $FEISHU_BASE_APP_TOKEN --table-id $FEISHU_TABLE_SIM_CARDS --filter '{"conjunction":"and","conditions":[{"field_name":"phone_number","operator":"is","value":["<used-phone>"]}]}' --as user
```

Expected: `bind_count` incremented, `last_bind_time` set, `cooldown_until` set, `bound_accounts` contains the email.

- [ ] **Step 5: Verify sub2api shows the account as active**

Open sub2api admin in ego-browser, search for the account email, confirm status is Active/normal.

- [ ] **Step 6: Commit any pattern updates**

```bash
git add skills/sub2api-auth/references/known-ui-patterns.md
git commit -m "docs: update known UI patterns from e2e validation"
```

---

## Self-Review

**Spec coverage check:**

| Spec Section | Implementing Task |
|---|---|
| 1. Goals & Scope | All tasks |
| 2. Architecture (ego-browser + agent) | Task 4 (SKILL.md playbook) |
| 3. Data Model (Feishu Base tables) | Task 1 |
| 4.1 SKILL.md Playbook | Task 4 |
| 4.2 ego-browser usage | Task 4 (playbook references ego-browser helpers) |
| 4.3 Feishu Base read/write | Task 1 (create) + Task 4 (playbook lark-cli commands) |
| 4.4 SIM pool logic | Task 4 (playbook SIM rules section) |
| 4.5 Provider doc parsing | Task 2 (rules) + Task 4 (Flow A) |
| 4.6 Known UI patterns | Task 3 (seed) + Task 6 (grow) |
| 5. Data flows | Task 4 (Flows A/B/C) |
| 6. Error handling | Task 4 (error recovery table) |
| 7. Security | Task 4 (hard rules: redact, no local cache) |
| 8. Testing | Task 6 (e2e) |
| 9. File structure | Tasks 2-5 |
| 10. Environment variables | Task 5 |
| 11. Dual visual model rules | Task 2 + Task 4 (hard rules) |
| 12. Open questions | Resolved during Task 6 e2e |

**Placeholder scan:** No TBD, TODO, or vague steps found.

**Type consistency:** Field names in Task 1 (Feishu Base creation) match field names referenced in Task 4 (playbook lark-cli commands) and Task 2 (parse rules echo format). Status enum values are consistent across all tasks.
