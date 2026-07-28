# sub2api-auth: Auto-Execute & Resumable No-SIM Design

**Date**: 2026-07-28
**Status**: Approved
**Scope**: Update `skills/sub2api-auth/SKILL.md` and related references to support paste-to-execute authorization, resumable waiting-for-SIM state, and full-automation CAPTCHA/OTP handling.

---

## 1. Problem Statement

The current playbook requires per-batch confirmation before writing to Base or starting authorization. The user wants a standing rule: pasting a valid `=== 使用说明 === / === 卡密内容 ===` order text is itself the execution authorization for that batch. Additionally, when no eligible SIM exists during phone binding, the account should enter a durable `waiting_sim` state instead of terminal `manual_required`, and automatically resume when a new SIM order is pasted.

## 2. Standing Authorization Rule

**Rule**: A structurally valid pasted order text (GPT or SIM) that passes format validation, quantity check, dedup, and type-evidence gates is treated as explicit batch authorization. The agent writes to Base and starts authorization (or resume) without asking for additional confirmation.

**Hard stops that still block auto-execution**:

- Structural validation failure (format mismatch, missing required fields)
- Stated quantity vs observed count mismatch
- Duplicate conflict unresolved
- Missing order timestamp for SIM validity calculation (use current time as conservative fallback per §4)
- Base API permission error
- sub2api admin login failure with no inherited session

## 3. Account Status State Machine

```
pending → authorizing → active
                  ↘
                   waiting_sim → authorizing → active
                  ↘
                   manual_required / failed
```

### Status definitions

| Status | Meaning |
|--------|---------|
| `pending` | Imported, not yet started |
| `authorizing` | Browser flow in progress |
| `active` | Successfully authorized in sub2api |
| `waiting_sim` | Phone binding required but no eligible SIM; durable, resumable |
| `manual_required` | Genuinely needs human intervention (CAPTCHA exhausted, unknown page exhausted, ownership error) |
| `failed` | Unrecoverable error |
| `revoked` | Previously active, token revoked |

### Transitions

- `pending → authorizing`: immediately after Base write readback confirms the new row.
- `authorizing → active`: sub2api readback shows exactly one matching row, status "正常", empty remark.
- `authorizing → waiting_sim`: phone binding page observed, SIM pool query returns zero eligible candidates.
- `waiting_sim → authorizing`: triggered by a new SIM order paste that adds at least one eligible SIM; query all `waiting_sim` accounts sorted by `waiting_since` ascending, process each.
- `authorizing → manual_required`: all automation attempts exhausted (CAPTCHA 3 rounds, unknown page 2 rounds, MFA+email both unreachable).
- `authorizing → failed`: unrecoverable error (e.g., sub2api rejects callback).

## 4. Order Parsing & Auto-Execute Flow

### Input detection

Each `=== 使用说明 === / === 卡密内容 ===` pair is an independent pack. Type is determined by keywords in the instruction section:

- GPT: "账号信息", "Gmail", "ChatGPT", "MFA", "密码默认"
- SIM: "手机号", "验证码地址", "接码", "取验证码"
- Neither matches → pause and ask user.

### GPT account parsing

- Shared password: match `密码默认：XXX` or `登入密码默认：XXX`; preserve raw characters.
- MFA platform URL: match `MFA 接码地址：URL`.
- Email list: one per line from 卡密内容; structural validation (contains `@`, valid domain shape).
- Password and MFA URL apply to all accounts in the pack.

### SIM card parsing

- Split each line on first `|`; fallback to first `----`.
- Left = phone number (digits, optional `+1` prefix). Right = SMS URL (must be HTTP(S)).
- Both sides non-empty.

### Dedup

- Before write, compare emails/phones against current Base records.
- Existing records are skipped; noted in summary.

### Order timestamp

- One-click-copy text does not contain order creation time.
- Conservative fallback: `valid_until = now + 30 days`.
- If user attaches order screenshot with visible timestamp, extract it (two visual reads must agree).

### Write-then-execute sequence

1. Parse all packs in the paste.
2. Write GPT accounts → readback → set `authorizing` → start Flow B per account.
3. Write SIM cards → readback → query `waiting_sim` accounts → resume each.
4. If paste contains both types: write all first, then execute GPT authorization, then resume waiting accounts.

### No-SIM behavior during authorization

- Account hits phone binding page → query SIM pool → zero eligible → set `waiting_sim`, `waiting_since = now`, close task space, continue next account.
- After all accounts processed, summary lists `waiting_sim` count and prompts user to paste SIM order.
- New SIM paste triggers automatic resume of all `waiting_sim` accounts.

## 5. CAPTCHA & OTP Full Automation

### Core principle

All challenges are attempted automatically first. Human handoff only after all automated means are exhausted.

### Cloudflare

- JS challenge: real Chromium usually passes automatically.
- "Verify you are human" checkbox: agent clicks it, waits 5–10s, re-observes.
- Full interstitial: wait 5–10s, re-observe; max 3 rounds.
- Still stuck after 3 rounds → handoff.

### reCAPTCHA / hCaptcha checkbox

- Agent locates checkbox via snapshotText or screenshot, clicks it.
- If escalated to image challenge ("select all traffic lights", etc.): screenshot → visual model identifies target image positions → click each → submit.
- Two independent visual reads on same screenshot must agree before submitting.
- Max 2 rounds of image challenge attempts.

### reCAPTCHA v3 / invisible

- Score-based; real Chromium usually passes. No extra action needed.

### MFA one-time password

- Read from MFA platform DOM or API.
- If page is visual-only: screenshot → visual model reads 6-digit code.
- Two independent reads must agree.
- If countdown < 5s: wait for refresh, max 2 wait cycles.

### SMS verification code

- Trigger send exactly once.
- Poll SMS platform page/API per provider's documented method.
- If page is visual-only: screenshot → visual model reads code.
- Avoid repeated resend (causes number invalidation).

### Unknown page

- Screenshot → visual model understands layout → locate inputs/buttons → act → screenshot to verify.
- Max 2 safe attempt rounds.

### Email mismatch on consent page

- If consent page shows a different email than the target: auto-logout → re-login with correct credentials → continue flow.
- Max 1 retry; if logout doesn't return to login page → handoff.

### Handoff conditions (exhaustion only)

- Cloudflare: 3 rounds of interstitial without passing.
- Image CAPTCHA: 2 rounds of visual identification failure.
- MFA + email helper both unreachable.
- Unknown page: 2 rounds without progress.
- On handoff: set `manual_required`, append redacted reason to `notes`, tell user what's stuck.
- User says "continue" → `takeOverTaskSpace`, observe page, resume from breakpoint.
- If task space expired/missing: restart authorization from scratch for that account.

## 6. Base Schema Changes

### `gpt_accounts` table

- `sub2api_status` single-select: add options `authorizing` and `waiting_sim`.
- New field `waiting_since` (datetime, optional): records when account entered `waiting_sim`; used for resume ordering and user visibility.

### `sim_cards` table

- No new fields. Existing `status`, `bind_count`, `cooldown_until`, `valid_until`, `bound_accounts` are sufficient.

### Pre-implementation steps

1. `+field-list` both tables to confirm current schema.
2. If `waiting_since` missing: `+field-create` with datetime type.
3. If `sub2api_status` is single-select: confirm/add `authorizing` and `waiting_sim` options via `+field-update` or `+field-search-options`.

## 7. Error Handling Summary

| Situation | Action |
|-----------|--------|
| Cloudflare interstitial | Auto-wait + retry, max 3 rounds, then handoff |
| reCAPTCHA/hCaptcha checkbox | Auto-click; if image challenge, visual model solves, max 2 rounds |
| MFA platform unreachable | Fallback to email helper; both fail → manual_required |
| SMS platform unreachable | Mark SIM unavailable, try next number |
| "Recently used" phone rejection | SIM cooldown 1h, try next; max 3 numbers total |
| 3 numbers exhausted, more available in pool | Continue with remaining |
| 3 numbers exhausted, pool empty | `waiting_sim` |
| Email mismatch on consent | Auto-logout + re-login, max 1 retry |
| Unknown page | Visual model explore, max 2 rounds, then handoff |
| sub2api admin login failure | Hard stop |
| Base API permission error | Hard stop |
| Paste validation failure | Hard stop, report errors |

## 8. Verification Strategy

- Every Base write followed by record_id readback; field values must match.
- sub2api success: exactly one matching row, status "正常", empty remark.
- Sensitive fields never projected to stdout/logs.
- Visual model OTP/CAPTCHA reads: two independent calls must agree.
- SIM pool selection: status=available, valid_until > now, cooldown expired, bind_count < 3, not tried this round, sorted by bind_count ascending.

## 9. Out of Scope

- No new `auth_runs` or `import_batches` table (deferred until concurrent runners are a real requirement).
- No local credential cache.
- No browser session persistence across turns (OAuth sessions expire; fresh login is more reliable).
- No concurrent authorization (one account at a time per agent turn).

## 10. Acceptance Scenario

1. Paste one valid GPT order (5 accounts) → all 5 written to Base as `pending` → immediately transition to `authorizing` → authorization starts without confirmation prompt.
2. During authorization, 2 accounts hit phone binding with no eligible SIM → set `waiting_sim` with `waiting_since` → task spaces closed → remaining 3 accounts continue.
3. Summary reports: 3 active, 2 waiting_sim.
4. User pastes one valid SIM order (3 numbers) → written to Base → readback confirms → agent queries `waiting_sim` accounts → resumes both in `waiting_since` order → authorization completes or enters next waiting state.
5. CAPTCHA encountered during login → agent auto-clicks checkbox → passes → continues without user intervention.
6. Image CAPTCHA encountered → visual model identifies targets → submits → passes.
7. Cloudflare interstitial persists after 3 rounds → handoff → user solves → says "continue" → agent resumes.
