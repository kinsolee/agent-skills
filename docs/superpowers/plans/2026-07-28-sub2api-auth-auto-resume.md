# sub2api-auth Auto-Execute & Resumable No-SIM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the sub2api-auth skill so that pasting valid order text auto-executes authorization, missing SIMs create a durable `waiting_sim` state that auto-resumes on new SIM paste, and all CAPTCHA/OTP challenges are fully automated before any human handoff.

**Architecture:** Documentation-only changes to SKILL.md and two reference files, plus a one-time Base schema migration (add field + options). No application code. Each task produces a self-contained, reviewable diff.

**Tech Stack:** Markdown skill files, Feishu Base (lark-cli), ego-browser

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-sub2api-auth-auto-resume-design.md`
- All Base datetime values use `YYYY-MM-DD HH:mm:ss`
- Sensitive values (passwords, tokens, MFA secrets, full emails, full phones, auth/callback URLs) are never printed to stdout, cliLog, commentary, or final output
- No local credential cache; Feishu Base is single source of truth
- sub2api remark field stays empty
- Every Base write followed by record_id readback
- Visual model OTP/CAPTCHA reads require two independent calls that agree

---

### Task 1: Base Schema Migration

**Files:**
- Read: `skills/sub2api-auth/.env` (for tokens)
- No file edits; this task runs lark-cli commands

**Interfaces:**
- Produces: `gpt_accounts` table gains `waiting_since` datetime field and `authorizing`/`waiting_sim` options on `sub2api_status`

- [ ] **Step 1: Load env and list current fields**

```bash
set -a; source skills/sub2api-auth/.env; set +a
lark-cli base +field-list --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --as user
```

Expected: JSON listing all fields including `sub2api_status` with its current options.

- [ ] **Step 2: Add `authorizing` and `waiting_sim` to `sub2api_status` options**

If `sub2api_status` is a single-select field, use `+field-update` to append the two new options while preserving all existing ones. If it is a text field, no schema change is needed (any string is valid).

```bash
lark-cli base +field-update --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --field-id "<sub2api_status_field_id>" --json '{"property":{"options":[{"name":"pending"},{"name":"authorizing"},{"name":"active"},{"name":"waiting_sim"},{"name":"manual_required"},{"name":"failed"},{"name":"revoked"}]}}' --as user
```

Read the field back to confirm both new options exist.

- [ ] **Step 3: Create `waiting_since` datetime field**

```bash
lark-cli base +field-create --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --json '{"field_name":"waiting_since","type":5}' --as user
```

(Type 5 = datetime in Feishu Base.) Read back to confirm the field exists.

- [ ] **Step 4: Commit evidence**

No file changes to commit. Record the field IDs and option names in the task output for reference by later tasks.

---

### Task 2: SKILL.md — Hard Rules Update

**Files:**
- Modify: `skills/sub2api-auth/SKILL.md` lines 61–62 (Hard Rules 1–2)

**Interfaces:**
- Consumes: nothing
- Produces: updated Hard Rule 2 that replaces per-batch confirmation with standing authorization

- [ ] **Step 1: Replace Hard Rule 2**

Replace the current Hard Rule 2 text (line 62) with:

```markdown
2. **Standing authorization on valid paste**: A structurally valid pasted `=== 使用说明 === / === 卡密内容 ===` order text that passes format validation, quantity check, dedup, and type-evidence gates is treated as explicit batch authorization. After parsing, echo a redacted structured preview with observed counts, source mode, missing fields, validation state, duplicate-check state, and one masked row per parsed item. If no blockers remain, write to Feishu Base and start authorization (or resume) immediately without asking for additional confirmation. Hard stops that still block auto-execution: structural validation failure, stated-quantity mismatch, unresolved duplicate conflict, Base API permission error, and sub2api admin login failure with no inherited session.
```

- [ ] **Step 2: Verify no other rule references per-batch confirmation**

Search SKILL.md for "explicit confirmation", "wait for explicit confirmation", "per-batch confirmation", "batch confirmation". Ensure no remaining rule contradicts the standing authorization rule. Hard Rule 2 is the only place that mandated it; other references in Flow A steps will be updated in Task 3.

- [ ] **Step 3: Commit**

```bash
git add skills/sub2api-auth/SKILL.md
git commit -m "feat(skill): replace per-batch confirmation with standing authorization rule"
```

---

### Task 3: SKILL.md — Flow A Auto-Execute

**Files:**
- Modify: `skills/sub2api-auth/SKILL.md` lines 83–98 (Flow A steps 1–10)

**Interfaces:**
- Consumes: Hard Rule 2 from Task 2
- Produces: Flow A that writes and auto-executes without confirmation wait

- [ ] **Step 1: Update Flow A step 4 (line 86) — conservative timestamp fallback**

Replace:

```
4. If metadata remains missing, show it as missing and ask one compact follow-up. A missing order timestamp blocks SIM `valid_until` calculation and authorization eligibility; it may not be replaced by paste/import time.
```

With:

```
4. If metadata remains missing, show it as missing and ask one compact follow-up. For SIM order timestamp: when the pasted text does not contain an order creation time and no accompanying screenshot provides one, use the current time as a conservative fallback (`valid_until = now + 30 days`). This underestimates actual validity but never overestimates it. If the user later provides an order screenshot with a visible timestamp, update `valid_until` accordingly.
```

- [ ] **Step 2: Update Flow A step 6 (line 88) — relax MFA type gate for auto-execute**

Replace:

```
6. Require observed live-response evidence before classifying an MFA or SMS URL as `网页` or `API`; never infer type from URL shape. Use only a schema-supported unknown state while evidence is absent. Because GPT MFA currently has no documented `unknown` enum, missing live type evidence blocks its write until schema/evidence resolution.
```

With:

```
6. Require observed live-response evidence before classifying an MFA or SMS URL as `网页` or `API`; never infer type from URL shape. When live evidence is absent at write time, set the type field to `unknown` (or leave it empty if the schema does not support `unknown`). The agent will probe the platform type during the first authorization attempt and update the field then. Missing type evidence does not block the write or auto-execution.
```

- [ ] **Step 3: Update Flow A steps 7–10 (lines 89–98) — remove confirmation wait, add auto-execute**

Replace lines 89–98 with:

```markdown
7. Echo the redacted structured preview specified in provider-parse-rules.md. Keep exact parsed values out of output. The preview must expose every blocker. If blockers remain, stop and ask for the missing evidence. If no blockers remain, proceed directly to step 8 without asking for confirmation.
8. Write to Feishu Base (same commands as before):
   - GPT accounts: `lark-cli base +record-batch-create --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" --json '{"fields":["email","password","source_order","source_provider","mfa_platform_url","mfa_platform_type","email_helper_url","sub2api_status"],"rows":[["<email>","<password>","<order>","<provider>","<mfa-url>","<网页-or-API-or-unknown>","<email-helper-or-null>","pending"]]}' --as user`
   - SIM cards: `lark-cli base +record-batch-create --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_SIM_CARDS" --json '{"fields":["phone_number","sms_url","sms_type","source_order","bound_accounts","bind_count","cooldown_until","valid_until","status"],"rows":[["<phone>","<sms-url>","<网页-or-API-or-unknown>","<order>",null,0,null,"<YYYY-MM-DD HH:mm:ss>","available"]]}' --as user`
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
```

- [ ] **Step 4: Commit**

```bash
git add skills/sub2api-auth/SKILL.md
git commit -m "feat(skill): Flow A auto-execute after write, conservative timestamp fallback"
```

---

### Task 4: SKILL.md — Flow B Updates (waiting_sim, CAPTCHA, email mismatch)

**Files:**
- Modify: `skills/sub2api-auth/SKILL.md` lines 100–211 (Flow B)

**Interfaces:**
- Consumes: Hard Rule 2 from Task 2, Flow A auto-execute from Task 3
- Produces: Flow B with `waiting_sim` transition, CAPTCHA automation, email mismatch auto-recovery

- [ ] **Step 1: Update Flow B trigger (line 102)**

Replace:

```
Triggered when user says "authorize", "授权", "开始授权", or confirms after Flow A.
```

With:

```
Triggered automatically after Flow A writes GPT accounts (standing authorization), or when user says "authorize", "授权", "开始授权", or when Flow D resumes a `waiting_sim` account.
```

- [ ] **Step 2: Update Flow B step 5 — add CAPTCHA/Cloudflare automation and email mismatch recovery**

After the existing "Unknown page" bullet (line 154–155) and before the "User-control or ownership error" bullet (line 157–158), insert two new bullets:

```markdown
   - **CAPTCHA / Cloudflare challenge**:
     Follow `references/known-ui-patterns.md` → "CAPTCHA & Cloudflare Automation". The agent attempts all automated resolution (click checkbox, wait for JS challenge, visual model solves image challenge) before considering handoff. Max 3 rounds for Cloudflare interstitial, max 2 rounds for image CAPTCHA. Only after all rounds fail does the agent call `handOffTaskSpace`.

   - **Email mismatch on consent page**:
     If the consent/authorization page displays an email that does not match the target account email from Base, the agent automatically logs out of OpenAI (click logout/sign-out), returns to the login page, and re-enters the correct credentials from Base. Max 1 retry; if logout does not return to a login page, call `handOffTaskSpace`.
```

- [ ] **Step 3: Update Flow B step 5 "Unknown page" bullet (line 154–155)**

Replace:

```
   - **Unknown page**:
     `captureScreenshot()`, analyze with visual model, attempt to proceed. If stuck after 2 attempts, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, emit only the returned `{done, skipped}` state, and ask the user for help only when `done === true`. If handoff is skipped, report the ownership state without claiming control was transferred.
```

With:

```
   - **Unknown page**:
     `captureScreenshot()`, analyze with visual model to understand page layout, locate inputs/buttons, and determine the next action. Act on the visual model's guidance, then screenshot to verify. Max 2 safe attempt rounds. If still stuck after 2 rounds, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, emit only the returned `{done, skipped}` state, and ask the user for help only when `done === true`. If handoff is skipped, report the ownership state without claiming control was transferred.
```

- [ ] **Step 4: Update Flow B step 6 no-SIM behavior (line 169)**

Replace:

```
   - If none available: mark account `manual_required`, skip to step 8
```

With:

```
   - If none available: update the GPT record to `sub2api_status=waiting_sim` and `waiting_since=<YYYY-MM-DD HH:mm:ss>`, read back, close the task space (step 9), and continue to the next account. Do not mark `manual_required` for recoverable inventory shortage.
```

- [ ] **Step 5: Update Flow B step 8 — add waiting_sim update path (after line 184)**

After the existing "Failure" bullet, add:

```markdown
   - No eligible SIM at phone binding: update the GPT record to `sub2api_status=waiting_sim` and `waiting_since=<YYYY-MM-DD HH:mm:ss>`. Read back both fields.
```

- [ ] **Step 6: Update Flow B Summary template (lines 203–211)**

Replace the summary block with:

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

- [ ] **Step 7: Commit**

```bash
git add skills/sub2api-auth/SKILL.md
git commit -m "feat(skill): Flow B waiting_sim, CAPTCHA automation, email mismatch recovery"
```

---

### Task 5: SKILL.md — Flow D, SIM Pool Rules, Error Recovery

**Files:**
- Modify: `skills/sub2api-auth/SKILL.md` lines 222–253 (SIM Pool Rules, Error Recovery, tail sections)

**Interfaces:**
- Consumes: `waiting_sim` status from Task 4
- Produces: Flow D (resume), updated SIM Pool Rules, updated Error Recovery table

- [ ] **Step 1: Add Flow D after Flow C (insert before `## SIM Pool Rules`)**

Insert a new section:

```markdown
## Flow D: Resume Waiting-SIM Accounts

Triggered automatically after a SIM card order is written and read back in Flow A step 10, or when user says "resume waiting", "继续等待的账号".

1. Query Feishu Base for all accounts with `sub2api_status=waiting_sim`, sorted by `waiting_since` ascending:
   ```bash
   lark-cli base +record-list --base-token "$FEISHU_BASE_APP_TOKEN" --table-id "$FEISHU_TABLE_GPT_ACCOUNTS" \
     --filter-json '{"logic":"and","conditions":[["sub2api_status","==","waiting_sim"]]}' \
     --field-id email --field-id sub2api_status --field-id waiting_since --sort-json '[{"field_name":"waiting_since","order":"asc"}]' \
     --format json --as user
   ```
2. If zero results, report "No waiting accounts" and stop.
3. For each account, follow Flow B steps 1–10 (full authorization from scratch; do not attempt to resume an expired browser session).
4. After all waiting accounts are processed, present the summary (same format as Flow B Summary).
```

- [ ] **Step 2: Update SIM Pool Rules (line 229)**

Replace:

```
- If no available card: account gets `sub2api_status=manual_required`.
```

With:

```
- If no available card: account gets `sub2api_status=waiting_sim` with `waiting_since=<now>`. This is a durable, resumable state — not a terminal failure.
```

- [ ] **Step 3: Update Error Recovery table (lines 233–245)**

Replace the entire Error Recovery table with:

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add skills/sub2api-auth/SKILL.md
git commit -m "feat(skill): add Flow D resume, update SIM pool rules and error recovery"
```

---

### Task 6: provider-parse-rules.md — Remove Confirmation, Add Conservative Timestamp

**Files:**
- Modify: `skills/sub2api-auth/references/provider-parse-rules.md`

**Interfaces:**
- Consumes: standing authorization rule from Task 2
- Produces: updated parsing rules consistent with auto-execute

- [ ] **Step 1: Update line 11 — SIM timestamp conservative fallback**

Replace:

```
- Never infer missing metadata from a URL host, current date, paste/import time, another pack, a prior order, or an example in this reference. Show each absent field as `missing` and ask one compact follow-up. A missing order timestamp blocks `valid_until` and makes the affected SIM ineligible for write or authorization.
```

With:

```
- Never infer missing metadata from a URL host, current date, paste/import time, another pack, a prior order, or an example in this reference. Show each absent field as `missing` and ask one compact follow-up. For SIM order timestamp: when the pasted text does not contain an order creation time and no accompanying screenshot provides one, use the current time as a conservative fallback (`valid_until = now + 30 days`). This underestimates actual validity but never overestimates it. If the user later provides an order screenshot with a visible timestamp, update `valid_until` accordingly.
```

- [ ] **Step 2: Update line 28 — relax MFA type gate**

Replace:

```
- Do not classify a platform as `网页` or `API` from URL shape. Require an observed live response. Until then use only a schema-supported unknown state; because GPT MFA currently has no documented `unknown` enum, absent live type evidence blocks that GPT write pending schema/evidence resolution.
```

With:

```
- Do not classify a platform as `网页` or `API` from URL shape. Require an observed live response. When live evidence is absent at write time, set the type field to `unknown` or leave it empty. The agent probes the platform type during the first authorization attempt and updates the field then. Missing type evidence does not block the write or auto-execution.
```

- [ ] **Step 3: Update line 35 — remove confirmation from echo format**

Replace:

```
4. After extraction, echo a structurally complete but redacted preview. If any metadata, quantity, structural, type-evidence, or duplicate blocker remains, request the missing evidence and do not ask for write confirmation. Only after every blocker is resolved may the preview ask for explicit confirmation for the current batch. Preserve counts, provider/order provenance, and one row per parsed item, but mask passwords, tokens, MFA material, full email addresses, full phone numbers, and secret-bearing URLs.
```

With:

```
4. After extraction, echo a structurally complete but redacted preview. If any metadata, quantity, structural, type-evidence, or duplicate blocker remains, request the missing evidence and stop. If no blockers remain, the preview is informational only — the agent proceeds directly to Base write and auto-execution without asking for confirmation. Preserve counts, provider/order provenance, and one row per parsed item, but mask passwords, tokens, MFA material, full email addresses, full phone numbers, and secret-bearing URLs.
```

- [ ] **Step 4: Update line 80 — SIM timestamp conservative fallback in parsing algorithm**

Replace:

```
3. Extract the order number, order-creation timestamp, stated validity range, and stated quantity. Missing order timestamp blocks `valid_until`; never substitute paste/import time.
```

With:

```
3. Extract the order number, order-creation timestamp, stated validity range, and stated quantity. When order timestamp is missing from both text and screenshots, use current time as conservative fallback for `valid_until` calculation (`now + 30 days`).
```

- [ ] **Step 5: Update line 81 — consistent valid_until computation**

Replace:

```
4. Compute `valid_until` only from the verified order-creation timestamp plus the stated upper-bound duration.
```

With:

```
4. Compute `valid_until` from the verified order-creation timestamp plus the stated upper-bound duration, or from the conservative fallback (`now + 30 days`) when no timestamp is available.
```

- [ ] **Step 6: Update echo format (line 111) — remove confirmation prompt**

Replace:

```
<If blockers exist, ask one compact evidence follow-up. Otherwise ask for explicit confirmation for this batch.>
```

With:

```
<If blockers exist, ask one compact evidence follow-up and stop. Otherwise proceed directly to Base write and auto-execution.>
```

- [ ] **Step 7: Update line 114 — remove standing-request prohibition**

Replace:

```
Never use an earlier general automation request as confirmation. Only explicit confirmation for the current parsed batch, issued after all blockers are resolved, permits its Base write or authorization start.
```

With:

```
A structurally valid pasted order text that passes all gates is itself the execution authorization for that batch. No additional confirmation is required. Hard stops (structural failure, quantity mismatch, unresolved duplicates, permission errors) still block auto-execution.
```

- [ ] **Step 8: Commit**

```bash
git add skills/sub2api-auth/references/provider-parse-rules.md
git commit -m "feat(skill): remove confirmation gates, add conservative timestamp fallback"
```

---

### Task 7: known-ui-patterns.md — CAPTCHA & Cloudflare Automation Patterns

**Files:**
- Modify: `skills/sub2api-auth/references/known-ui-patterns.md`

**Interfaces:**
- Consumes: CAPTCHA automation rules from Task 4
- Produces: new provenance-tagged patterns for CAPTCHA/Cloudflare automation and visual model integration

- [ ] **Step 1: Update Browser Operating Contract item 8 (line 23)**

Replace:

```
8. If manual login, CAPTCHA, or another user-only step is required, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, check that the result reports `done: true`, and explain the required action.
```

With:

```
8. If CAPTCHA or Cloudflare challenge is detected, follow the "CAPTCHA & Cloudflare Automation" pattern below before considering handoff. Handoff is only appropriate after all automated resolution rounds are exhausted. For manual login or other genuinely user-only steps, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, check that the result reports `done: true`, and explain the required action.
```

- [ ] **Step 2: Update OpenAI OAuth — Login Page step 3 (line 93)**

Replace:

```
3. `snapshotText()` — if a challenge is present, wait and retry every 3 seconds for at most 30 seconds. If it remains, hand off the task space and ask the user to solve it; do not bypass it.
```

With:

```
3. `snapshotText()` — if a Cloudflare or CAPTCHA challenge is present, follow the "CAPTCHA & Cloudflare Automation" pattern below. Only after all automated rounds are exhausted should the agent hand off the task space.
```

- [ ] **Step 3: Add new section "CAPTCHA & Cloudflare Automation" before the `---` separator (before line 181)**

Insert:

```markdown
## CAPTCHA & Cloudflare Automation

Evidence:
- `evidence_status`: `screenshot_inferred`
- `source`: design spec `docs/superpowers/specs/2026-07-28-sub2api-auth-auto-resume-design.md` §5
- `as_of`: `2026-07-28`
- `scope_note`: automation strategy derived from ego-browser capabilities and visual model integration; no live CAPTCHA encounter has been verified yet; observe actual challenge type before each action

Core principle: all challenges are attempted automatically first. Human handoff only after all automated means are exhausted.

### Cloudflare JS Challenge

Real Chromium usually passes JS challenges automatically. Wait 5–10 seconds after page load, then `snapshotText()` to check if the challenge cleared. If still present, wait another 5 seconds and retry. Max 3 wait cycles.

### Cloudflare "Verify You Are Human" Checkbox

1. `snapshotText()` or `captureScreenshot()` to locate the checkbox element.
2. Click the checkbox using a current ref or coordinate.
3. Wait 5–10 seconds, then `snapshotText()` to verify the challenge cleared.
4. If the checkbox escalates to an image challenge, follow the Image CAPTCHA steps below.
5. Max 3 rounds of click-and-wait. If still stuck, handoff.

### Cloudflare Full Interstitial

1. Wait 5–10 seconds after detecting the interstitial page.
2. `snapshotText()` to check if it auto-resolved.
3. If not, wait another 5–10 seconds and retry.
4. Max 3 rounds. If still stuck, handoff.

### reCAPTCHA / hCaptcha Checkbox

1. `snapshotText()` or `captureScreenshot()` to locate the checkbox (typically an iframe with a checkbox or "I'm not a robot" label).
2. Click the checkbox using a current ref or coordinate.
3. Wait 3–5 seconds, then observe whether the challenge cleared or escalated to an image challenge.
4. If escalated, follow the Image CAPTCHA steps below.

### Image CAPTCHA (reCAPTCHA / hCaptcha image grid)

1. `captureScreenshot()` to get the current page state showing the image grid and instruction text (e.g., "Select all images with traffic lights").
2. Send the screenshot to a visual model with the instruction: identify the grid positions (row, column) of images matching the challenge prompt.
3. Run two independent visual model calls on the same screenshot. Both must return the same set of positions.
4. If the two reads disagree, take a fresh screenshot and retry once. If still disagreeing, handoff.
5. Click each identified position using viewport coordinates derived from the screenshot grid layout.
6. Click the Verify/Submit button.
7. Wait 3–5 seconds, then observe whether the challenge cleared or a new image grid appeared.
8. Max 2 rounds of image challenge attempts. If still stuck, handoff.

### reCAPTCHA v3 / Invisible

Score-based; real Chromium with normal browsing behavior usually passes. No extra action needed. If the page stalls after form submission, wait 5 seconds and re-observe.

### Visual Model OTP Reading

When an MFA or SMS platform page displays a code only as visual content (no accessible DOM text or API):

1. `captureScreenshot()` the relevant page region.
2. Send to a visual model with instruction: extract the 4–8 digit verification code.
3. Run two independent visual model calls. Both must return the same code.
4. If they disagree, wait for a page refresh (if countdown is visible, wait for it), take a new screenshot, and retry once.
5. If still disagreeing, do not guess; mark the step as failed and follow the error recovery path.

### Unknown Page Visual Exploration

When the page does not match any known pattern:

1. `captureScreenshot()` the full page.
2. Send to a visual model with instruction: describe the page layout, identify all interactive elements (inputs, buttons, links), and suggest the most likely next action to progress the authorization flow.
3. Act on the visual model's guidance using coordinate clicks or keyboard input.
4. `captureScreenshot()` again to verify the result.
5. Max 2 rounds of visual exploration. If no progress, handoff.
```

- [ ] **Step 4: Update Phone Binding step 10 (line 145) — waiting_sim instead of manual_required**

Replace:

```
10. If 3 verified attempts are exhausted, mark the account `manual_required` and read back that state. Do not infer exhaustion from an unobserved screenshot hypothesis.
```

With:

```
10. If 3 verified attempts are exhausted and no more eligible SIMs exist in the pool, set the account to `sub2api_status=waiting_sim` with `waiting_since=<now>` and read back. If more eligible SIMs remain, continue trying. Do not infer exhaustion from an unobserved screenshot hypothesis.
```

- [ ] **Step 5: Commit**

```bash
git add skills/sub2api-auth/references/known-ui-patterns.md
git commit -m "feat(skill): add CAPTCHA/Cloudflare automation and visual model patterns"
```

---

### Task 8: Final Consistency Check

**Files:**
- Read: all three modified files

**Interfaces:**
- Consumes: all changes from Tasks 2–7
- Produces: verified internal consistency

- [ ] **Step 1: Search for stale references**

```bash
rg -n "per-batch confirmation|wait for explicit confirmation|batch confirmation|A general standing request" skills/sub2api-auth/
```

Expected: zero matches. If any remain, fix them.

- [ ] **Step 2: Search for stale no-SIM behavior**

```bash
rg -n "no available card.*manual_required|none available.*manual_required|no SIM.*manual_required" skills/sub2api-auth/
```

Expected: zero matches. All no-SIM paths should now say `waiting_sim`.

- [ ] **Step 3: Verify state machine completeness**

Check that every status mentioned in SKILL.md (`pending`, `authorizing`, `active`, `waiting_sim`, `manual_required`, `failed`, `revoked`) has at least one transition into it and one transition out of it (except terminal states `active`, `failed`).

- [ ] **Step 4: Verify Flow D is referenced**

```bash
rg -n "Flow D" skills/sub2api-auth/SKILL.md
```

Expected: at least 2 matches (the section header and the reference from Flow A step 10).

- [ ] **Step 5: Commit any fixes**

```bash
git add -A skills/sub2api-auth/
git commit -m "fix(skill): consistency fixes from final review" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- §2 Standing Authorization → Task 2 (Hard Rule 2), Task 3 (Flow A steps 7–10), Task 6 (provider-parse-rules)
- §3 State Machine → Task 4 (waiting_sim transitions), Task 5 (Flow D, SIM Pool Rules)
- §4 Order Parsing → Task 3 (conservative timestamp), Task 6 (parsing rules)
- §5 CAPTCHA Automation → Task 4 (Flow B step 5), Task 7 (known-ui-patterns)
- §6 Base Schema → Task 1
- §7 Error Handling → Task 5 (Error Recovery table)
- §8 Verification → embedded in each task's readback steps
- §9 Out of Scope → respected (no new tables, no local cache)
- §10 Acceptance → covered by the combination of Tasks 3–5

**Placeholder scan:** No TBD, TODO, or vague steps found.

**Type consistency:** `waiting_sim`, `authorizing`, `waiting_since` used consistently across all tasks. `sub2api_status` field name matches throughout.
