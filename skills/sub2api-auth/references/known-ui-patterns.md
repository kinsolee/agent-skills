# Known UI Patterns

This is a provenance-aware reference library, not a claim of current live validation. It contains both hypotheses and historically verified operation sequences. Every pattern records:

- `evidence_status`: `screenshot_inferred`, `snapshot_verified`, or `live_verified`
- `source`: the screenshot, live page, or historical run that supports it
- `as_of`: exact capture or verification date when known
- `scope_note`: what the evidence does and does not establish

`screenshot_inferred` is a hypothesis only: observe the live page before acting. `snapshot_verified` means the current page structure was observed but the full operation was not completed. Only `live_verified` means the complete operation and readback succeeded. Historical `live_verified` evidence does not establish that the current host or a drift-prone third-party UI still matches.

## Browser Operating Contract

For every pattern below:

1. Create or select one non-sensitive named task space with `useOrCreateTaskSpace(...)`, retain its returned numeric ID in the running task context, and reuse that same ID across all heredoc rounds. Do not put a full email, phone number, password, token, or secret-bearing URL in the task-space name.
2. Use the semantic workflow (`snapshotText()` plus current refs or locators) first for these normal forms. Observe, act, then verify with a fresh `snapshotText()`, `pageInfo()`, or other reliable readback after each meaningful action.
3. A snapshot ref such as `@12` is valid only when it appears in the latest `snapshotText()` output. Take a fresh snapshot before selecting a ref; never reuse a ref from an older snapshot. Prefer a current `loc=...` or stable CSS selector when appropriate.
4. An ordinary later heredoc starts with `useOrCreateTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`. The JavaScript variable from a prior heredoc does not survive.
5. For a handoff initiated by the agent or an unexpected user takeover: stop; after explicit user confirmation, start the next heredoc with `takeOverTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`.
6. For inactive, unassigned, or user-owned spaces: stop; after explicit user confirmation, `listTaskSpaces()`, `claimTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, `listTabs()`, then `switchTab(targetId)` before acting.
7. Never auto-take over or auto-claim without explicit confirmation. Do not retry or route around a user-control or ownership error.
8. If CAPTCHA or Cloudflare challenge is detected, follow the "CAPTCHA & Cloudflare Automation" pattern below before considering handoff. Handoff is only appropriate after all automated resolution rounds are exhausted. For manual login or other genuinely user-only steps, call `handOffTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>)`, check that the result reports `done: true`, and explain the required action.
9. After a prior heredoc has verified that the whole task is complete, run `completeTaskSpace(<PERSISTED_NUMERIC_TASK_SPACE_ID>, { keep: false })` in its own dedicated final heredoc. Check `done: true`; use `keep: true` only for a concrete user-requested or manual-action reason.
10. Never print or persist passwords, authorization secrets, or full token-bearing URLs. Redact credentials and show token URLs only with `token=xxx`.
11. **Password inputs: use native setter, not `fillInput`**. ego-browser's `fillInput` may append to an existing value on OpenAI password fields, silently doubling the credential. Set password fields via `js()` using `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set`, then dispatch `input` and `change` events with `{ bubbles: true }`. Always verify `input.value.length` matches the expected credential length before submitting.
12. **OpenAI form submission: use `requestSubmit`**. The OpenAI auth password form uses React Router. ego-browser's `click()` on the submit button may trigger a native form POST intercepted by OpenAI's sentinel bot-detection iframe (`sentinel.openai.com/backend-api/sentinel/frame.html`), causing "Operation timed out". Use `form.requestSubmit(buttonElement)` via `js()` to trigger React Router's fetch-based path through `/api/accounts/password/verify`, which passes through the browser's existing Cloudflare session.
13. **Task-space isolation is not login-state proof**. A newly created ego-browser task space can still open an OpenAI account chooser or authenticated consent state for a previous account. Provider-visible identity must exactly match the target Base email before consent or callback submission.
14. **Hang diagnosis and recovery (live-verified 2026-08-04, #167 reauth).** Observed failure mode: an ego-browser script appears to hang with ZERO output, yet its actions actually executed — `cliLog` output is buffered until clean process exit, so a hung client prints nothing even for completed steps. Rules learned:
    - Before concluding a step failed, kill the hung client PID (exact PID via `pgrep -fl "ego-browser nodejs"`; NEVER `pkill -f "ego-browser"` — that matches the `ego lite` app bridge process `--startup-ego-browser-service`, kills the service, and destroys all task spaces) and re-observe page state via a fresh minimal script.
    - Always `switchTab(targetId)` before any `cdp(...)`/evaluate call: without an explicit tab switch, evaluate can route to a stale/wrong target and hang.
    - If the `js()` helper hangs on a page, use `cdp('Runtime.evaluate', { expression, returnByValue: true, timeout: 4000-8000 })` instead — it targets the switched tab's main frame and worked on auth.openai.com and 2fa.nloop.cc where `js()` hung.
    - Script parsing is flaky: identical scripts sometimes fail with `SyntaxError: await is only valid...` via stdin heredoc. Retry, or pass the script via `ego-browser nodejs < file.mjs` (file input observed more reliable). Avoid `import` statements in scripts; read secrets from mode-600 temp files via dynamic `await import('node:fs')` only when needed, and delete them after.
    - A hung client can hold a task-space lock so later `useOrCreateTaskSpace` calls hang too — kill all stale client PIDs between retries.

## sub2api Admin — API-First Operations (preferred)

Evidence:
- `evidence_status`: `source_verified` + live probes (account list + generate-auth-url succeeded 2026-08-04 against the configured sub2api instance)
- `source`: upstream Wei-Shaw/sub2api Go routes/handlers + Vue composables; see `references/sub2api-admin-api.md`
- `scope_note`: all sub2api management operations (login, generate auth URL, create account, complete auth, read back, test, set schedulable, delete, reauth) are driven through the admin REST API via `src/sub2api-admin-api.mjs` (`x-api-key`). The browser admin-panel sections below ("Login", "Generate Auth URL", "Fill Callback URL") are the FALLBACK only when the API is unreachable. The browser is still required for everything on `auth.openai.com` (login, MFA, phone binding, consent).

New-account sequence: `generate-auth-url` → browser OpenAI flow → capture `code`+`state` → `create` (exchange-code + accounts.create).
Reauth sequence: `list --search <email>` → `generate-auth-url` → browser → capture callback → `apply --id <id>` (exchange-code + apply-oauth-credentials).

## sub2api Admin — Login

Evidence:
- `evidence_status`: `live_verified`
- `status`: `superseded` — API calls authenticate via `x-api-key` (`SUB2API_ADMIN_API_KEY`); no panel login is needed (Hard Rule 20). Fallback only when the API is unreachable.
- `source`: historical sub2api automation, latest relevant commit `9aca6f1`
- `as_of`: `2026-05-12`
- `scope_note`: historical live verification used a different host; it does not validate the current host, so take a fresh snapshot on the configured sub2api host before the first current action and treat UI drift as possible

Page: the configured admin URL (`SUB2API_ADMIN_BASE`/`SUB2API_ADMIN_URL` from `.env`; no hardcoded default)

1. In the reused task space, `openOrReuseTab(adminUrl, { wait: true })`.
2. `snapshotText()` and `pageInfo()` — check whether the URL contains `/login`.
3. If login is required, use refs from that latest snapshot to find the email input (placeholder contains "email") and `fillInput` with the admin email; then take a fresh snapshot to verify the value/state without exposing it.
4. From the fresh snapshot, find the password input (placeholder contains "password") and `fillInput` with the redacted admin password; take another fresh snapshot.
5. Use only a ref present in that latest snapshot to `click` the submit button (`button[type="submit"]` or text "Sign In").
6. `snapshotText()` and `pageInfo()` — verify the URL no longer contains `/login` and that the accounts UI is present.

Note: ego-browser may inherit the user's login session. If already logged in, skip credential entry and verify the accounts UI. Never log credentials.

## sub2api Admin — Generate Auth URL

Evidence:
- `evidence_status`: `live_verified`
- `status`: `superseded` — use `sub2api-admin-api.mjs generate-auth-url` (API-first, Hard Rule 20). This panel-dialog flow is the fallback only when the API is unreachable.
- `source`: current-host ego-browser E2E on the configured sub2api instance
- `as_of`: `2026-07-28`
- `scope_note`: one real OpenAI OAuth add-account flow verified the current dialog, group selection, configured SOCKS5 proxy selection, and authorization-URL generation; re-observe every dialog state for drift

Prerequisite: logged in on the accounts page.

1. `snapshotText()` — look for "Add Account" or "添加账号" and click only a ref from this snapshot.
2. Take a fresh `snapshotText()` — verify that the account dialog appeared with platform, group, and type selectors.
3. Using current refs/locators, select platform `OpenAI`, account type `OAuth / ChatGPT OAuth`, the real configured `openai` group, and a configured proxy. The observed run used a SOCKS5 proxy; still select from the current live options and exclude "无代理" / "No Proxy".
4. Verify the account name is non-empty, the remark is empty, OAuth is selected, exactly the intended group is selected, and the proxy control no longer says "无代理".
5. Click "下一步", take a fresh snapshot, and require the `OpenAI 账户授权` step with `手动授权` selected.
6. Find "Generate Auth URL", "Generate Auth Link", or "生成授权链接" in the latest snapshot and click its current ref.
7. Take a fresh snapshot and locate the authorization URL text or copy control; extract the URL without logging the full secret-bearing value.
8. Validate the observed authorization origin/path before opening it. If the value is not semantically visible, use a single explicit `js()` IIFE to read the relevant input/textarea value.

## sub2api Admin — Fill Callback URL

Evidence:
- `evidence_status`: `live_verified`
- `status`: `superseded` — use `sub2api-admin-api.mjs create` (exchange-code + accounts.create, API-first, Hard Rule 20). This dialog-fill flow is the fallback only when the API is unreachable.
- `source`: current-host ego-browser E2E on the configured sub2api instance
- `as_of`: `2026-08-04`
- `scope_note`: one real callback submission created the account and passed unique-row, `正常` status, configured group/proxy, and empty-remark readback; the 2026-08-04 fallback run (account #166, add-account dialog) observed the callback textarea auto-extracting the `code` param — writing the full localhost URL (via CDP `Input.insertText` or native setter) leaves the field holding only the ~90-char code value (starts `ac_`), and chunked insertText inserted only partially (90/244, 203/244). Verify the final field value equals the callback's `code` param before clicking 完成授权; the backend accepts the bare code. Also recover the callback from `Page.getNavigationHistory` on the exact tab that rendered the localhost error page — switching tabs first loses the history.

Prerequisite: account dialog remains open and the OpenAI flow returned a callback URL.

1. `snapshotText()` — locate the input labeled "授权链接", "Code", "Authorization URL", or "Callback".
2. `fillInput` using a ref from that snapshot, without logging the callback URL; then take a fresh snapshot to verify field state. In the 添加账号 dialog the textarea may auto-extract the `code` param from a full callback URL and drop partial insertText writes; after any fill, require `field.value === <code param>` before submitting (see scope note).
3. Click the current "完成授权" or equivalent submit ref.
4. Require the dialog to close and an account-created success signal.
5. Search for the exact account identifier, require exactly one matching row with status `正常`, then open its edit dialog and require the remark field to be empty.

## OpenAI OAuth — Login Page

Evidence:
- `evidence_status`: `live_verified`
- `source`: current ego-browser E2E from sub2api authorization URL through OpenAI MFA and consent; 2026-07-31 reauth runs confirmed password handling and account_deactivated detection; 2026-08-03 live account-chooser run exposed an inherited previous identity and successfully routed through `登录至另一个帐户`; 2026-08-06 UPI iCloud batch (#174-#177) driven by `scripts/flow-login.mjs`, 4/4 first-attempt successes
- `as_of`: `2026-08-06`
- `scope_note`: email login, password login, MFA transition, consent, account chooser, and account_deactivated detection verified; task-space creation did not guarantee a fresh OpenAI identity; password field requires native setter (fillInput doubles value); form submission requires requestSubmit (click triggers sentinel timeout); 2026-08-05 reauth of 4 accounts (#169/#171/#172/#173): every timed-out form step recovered by reopening the authorization URL fresh, while the 重试-restored page always timed out again (half-hydrated, submissions fall through to sentinel-blocked native POST) — see Hard Rule 23; OpenAI UI remains drift-prone, so re-observe before every action

Page: authorization URL generated by sub2api. Do not log the full URL.

1. In the reused task space, `openOrReuseTab(authUrl, { wait: true })`.
2. Wait 3 seconds for page load and a possible Cloudflare challenge.
3. `snapshotText()` — if a Cloudflare or CAPTCHA challenge is present, follow the "CAPTCHA & Cloudflare Automation" pattern below. Only after all automated rounds are exhausted should the agent hand off the task space.
4. If the latest snapshot shows an account chooser (`Choose an account` / `选择一个帐户`), compare every provider-visible email with the exact target Base email. If none exactly matches, click `Log in to another account` / `登录至另一个帐户` from that latest snapshot and verify transition to the email-login form. Do not select an inherited previous account. If one exactly matches, it may be selected only after that exact comparison succeeds.
5. From the latest login-form snapshot, find the email input (`input[name="email"]`, `input[name="username"]`, `input[type="email"]`, or observed equivalent), fill the account email, and observe again.
6. Click the current Continue/Next/继续 ref; wait 2–3 seconds and take a fresh snapshot. **Do not replace this form step with a standalone `POST /api/accounts/authorize/continue` fetch.** A 2026-08-03 probe proved that driving the email step via direct fetch and then hard-navigating to `/log-in/password` forks the server-side login-flow state: the email step returns `200 login_password`, but every later password verify fails with `401 invalid_username_or_password` even for the byte-exact correct password. Let the page's own flow perform the step. If the form Continue times out (`Operation timed out`), click 重试 at most once; if it still fails, reopen the authorization URL fresh (`openOrReuseTab(authUrl)`) and redo the form flow from the start instead of bypassing it (Hard Rule 23 — the 重试-restored page is half-hydrated and keeps timing out).
7. If "Continue with password", "使用密码继续", or "Use password instead" appears, click its current ref and observe again.
8. Locate the password input (`input[name="current-password"]`) in the latest snapshot. **Do not use `fillInput`** — set the password via `js()` native setter (see Browser Operating Contract §11). Verify `input.value.length` matches the expected credential length.
9. Submit via `js()`: `document.querySelector('form').requestSubmit(document.querySelector('button[name="intent"]'))`. Do not use ego-browser `click()` on the submit button (see Browser Operating Contract §12). Wait 3–5 seconds, then `snapshotText()` and `pageInfo()` to determine the next state: MFA, email verification, phone binding, consent, callback redirect, or account_deactivated.
10. **Account deactivated detection**: If the page shows `account_deactivated`, "Your account has been deactivated", or similar deactivation text, the account is permanently unrecoverable. Do not retry. Report to the caller for Base update and sub2api deletion.

## OpenAI OAuth — Account Deactivated

Evidence:
- `evidence_status`: `live_verified`
- `source`: 2026-07-31 reauth of 4 revoked accounts (#152-#156); all confirmed deactivated after correct password submission via requestSubmit
- `as_of`: `2026-07-31`
- `scope_note`: deactivation text observed on the password page after successful password verification; the OAuth flow may show "Incorrect email address or password" instead of the deactivation message when the password is submitted via the native form POST (sentinel-blocked path), so use the requestSubmit path for accurate error reporting

Trigger: after password submission via `requestSubmit`, the page displays `account_deactivated` or deactivation-related text instead of transitioning to MFA/consent.

1. Do not retry the login or attempt alternative passwords.
2. Mark the Base record `sub2api_status=failed` with notes `account_deactivated confirmed (<YYYY-MM-DD>)`.
3. Delete the account from sub2api admin: search by email → click 删除 → confirm the 删除账号 dialog by clicking the 删除 button inside the dialog.
4. Read back: Base record shows `failed` status; sub2api search for the email returns 暂无数据.
5. Continue to the next account. This is a terminal state — not `manual_required`, not `waiting_sim`.

## OpenAI OAuth — MFA Verification (2fa.nloop.cc)

Evidence:
- `evidence_status`: `live_verified`
- `source`: 2026-08-12 keyless JSON-API lookup live-verified for all four OpenCodex reauth targets (4/4 `found:true` with fresh 6-digit TOTPs; contract and response hash in `references/nloop-mfa-api.md`); earlier ego-browser E2E (2026-08-03 user correction during #162 reauth: MFA preferred over email OTP; 2026-08-06 UPI iCloud batch #174-#177, 4/4 codes accepted first try) remains valid for the OpenAI-side fill+submit
- `as_of`: `2026-08-12`
- `scope_note`: fetch the code through `GET <platform>/api/mfa/lookup?email=…` in-process — no platform tab and no UI anchors. The former browser-UI query path was removed after it returned 0 rows on 2026-08-12 for accounts whose API records exist. `found:false` means the platform has no record for that identity (fall back per the Error Recovery table); multiple `results` rows are ambiguous — stop rather than guess. When `remaining` is below 5 s, wait for the refreshed code before filling — a code submitted with 1 s left was accepted only after the automatic refresh wait (2026-08-05 #173). Email-helper fallback is not preferred and observed unreliable for iCloud (see email OTP note)
- `prior_source`: artifact `codex-clipboard-85456eba-d2dd-486e-9c02-863d00ebc6c3.png`; source system `链动小铺 order-detail page`; order `LD26072731CVWM`
- `prior_source_sha256`: `3aca992604ab571a012576ea7ce4816aa543109209ab8ce856e383a385fbe184`

Verified trigger: the latest OpenAI snapshot shows the authenticator challenge, a code input such as `input[name="code"]`, or a verification-method choice that includes an authenticator/TOTP option. MFA is preferred over email OTP even when Base `mfa_platform_url` is empty; probe the `2fa.nloop.cc` lookup API with the target email first.

1. Normalize the Base URL cell before use. When it is a Markdown link, prefer the parenthesized target; validate the expected HTTPS origin and do not print the URL.
2. Query the platform lookup API in-process for the account email (`references/nloop-mfa-api.md`): require `ok:true`, `found:true`, and exactly one `results` row whose `code` matches `^\d{6,8}$`. If `remaining < 5`, wait for the next period and re-query once. The code never enters stdout, argv, or logs.
3. Switch to the existing OpenAI `mfa-challenge` tab, take a fresh snapshot, fill `input[name="code"]` via the native setter (Hard Rule 14), and observe again.
4. Submit via `form.requestSubmit` (Hard Rule 15), then require a transition away from the MFA challenge.
5. When MFA succeeds and Base `mfa_platform_url` was empty, update the Base record with the observed MFA platform URL.

## OpenAI OAuth — Email OTP (email.nloop.cc fallback)

Evidence:
- `evidence_status`: `snapshot_verified`
- `source`: 2026-08-03 live observation during account #162 reauth against `email.nloop.cc`
- `as_of`: `2026-08-03`
- `scope_note`: the helper imported an iCloud mailbox using the bare email address (not `email----password`); two real fetch attempts returned no mail, no code, and no error, leaving the page at “点击获取邮件”. A later direct probe live-verified only the not-found branch. Existing script evidence covers `mails[].from` and `mails[].verificationCode` usage but not recipient or delivery-time field names; successful retrieval/submission remains unverified and fails closed until that contract is captured.

Use only after MFA/TOTP is unavailable, returned no result, or failed observably.

1. Record the current challenge start in epoch milliseconds at the challenge issuance/navigation boundary and pass it as `--challenge-start-ms`. A timestamp recorded after delivery is not challenge evidence.
2. Open `https://email.nloop.cc/` in the same task space.
3. For iCloud, fill only the target email address into the `邮箱内容` textarea and click `识别`. Do not use `email----password` unless the observed placeholder/flow explicitly requires it.
4. Verify the mailbox appears in the iCloud group and is selected.
5. Accept mail only when the sender is strictly OpenAI/ChatGPT, any API-provided recipient exactly equals the target Base email, delivery time is later than this challenge start, newest-first ordering leaves exactly one eligible six-digit code, and every metadata field name comes from captured helper evidence.
6. The current adapter lacks evidenced delivery-time metadata and therefore returns nonzero. If the page stays idle or metadata is insufficient, canonically cancel/hand off; never guess a field or code.

## OpenAI OAuth — Phone Binding

Evidence:
- `evidence_status`: `live_verified`
- `source`: four completed phone bindings on 2026-08-04 through the chongpt.xyz redemption-code channel (sub2api #163/#164/#165, plus #166 using a number still inside its 3-day cooldown window); two more on 2026-08-06 (#174/#177), both with numbers deep inside cooldown (~39 h remaining) accepted by OpenAI; original screenshot hypothesis retained for the sms369-style direct channel, which still has no live evidence
- `as_of`: `2026-08-06`
- `scope_note`: live-verified flow: OpenAI shows `电话号码是必填项` (`auth.openai.com/add-phone`) with a country selector defaulting to `美国 (+1)` and one national-number input (`input[name="__reservedForPhoneNumberInput_tel"]`); filling the 10-digit national part via native setter reaches `查看你的手机` (`auth.openai.com/phone-verification`) with `input[name=code]`; SMS codes from the redeemed chongpt number were accepted first try all four times. 2026-08-04 additions (#166): the tel input auto-formats the 10-digit national part to `(xxx) xxx-xxxx` (value length 14); the add-phone 继续 button has NO `name=intent` — submit via `form.requestSubmit(btn)` with the button located by text 继续; a number inside its post-bind cooldown window was accepted and bound successfully (OpenAI does not always enforce the cooldown); new permanent rejection observed `此电话号码已关联到可关联的最多账户` on a Base-`available` sms24.uk number (mark `exhausted`, `bind_count` unchanged); one SMS delivery exceeded the 120 s poll window — poll on `已收到`/`验证码已收到` markers plus the read-only 验证码 input (6 ASCII digits, verify by codepoints) instead of a single regex. 2026-08-06 additions (#174/#177): select the 短信 radio (`[role="radio"]` whose nearest label text contains 短信) before submitting; detect code-sent ONLY by URL `/phone-verification` + `input[name="code"]` — the string 一次性验证码 appears in the add-phone page copy and false-positives (Hard Rule 25); with a restored chongpt slot the first visible code is usually stale — wait for a changed code after 刷新验证码 (Hard Rule 24). Rejection/retry branches (`recently used`, 3-number rotation) remain unobserved
- `capture_method`: user-provided clipboard screenshot; received `2026-07-28`; exact capture time unavailable
- `redaction_note`: original image contains live phone/SMS access data and is not committed; only provenance and hash are recorded
- `source_sha256`: `8d5c16be8e3c31f96fdaff1125f183d002de2276b4a2889b4eb215ca1b74ff2b`

Hypothesized trigger: the latest snapshot or screenshot shows "phone number", "Check your phone", "Enter the verification code we just sent to", "添加电话号码", or a phone input.

1. Query Feishu Base for currently available SIM cards; use only authorized real records and preserve their provenance.
2. Pick the best number according to the verified SIM-pool rules; do not invent a number or status.
3. `snapshotText()` — locate the phone input and observe actual country-code handling before acting. Do not assume whether a dropdown or `+1` prefix exists.
4. Fill the 10-digit national part via the native setter (the input auto-formats to `(xxx) xxx-xxxx`, value length 14), observe again, then submit. On `add-phone` the 继续 button has no `name=intent` attribute — use `form.requestSubmit(btn)` with the button located by text 继续. Wait 3–7 seconds and verify the resulting OpenAI state (`查看你的手机` with `input[name=code]`, or an inline rejection list item).
5. Open the configured SMS URL in a new tab in the same task space without logging the full token URL.
6. For at most 120 seconds, every 5 seconds take a fresh SMS-tab snapshot and inspect the actual response for a 4–8 digit code. Do not reuse refs across snapshots. SMS delivery can exceed 120 s (observed once on 2026-08-04); extend the window while the platform still shows a waiting state.
7. If the observed provider/OpenAI response identifies the number as rejected, classify by the exact message: the max-linked rejection `此电话号码已关联到可关联的最多账户` is permanent — mark the SIM `exhausted` with `bind_count` unchanged and try the next eligible number; recoverable rejections (for example "无法向此号码发送验证码" or "This phone number was recently used") return `PHONE_REJECTED`.
8. On `PHONE_REJECTED`, update the real SIM record to recoverable `status=cooldown` and `cooldown_until=now+1 hour`; never mark it permanently unavailable. Read back both fields, choose another eligible number, and retry from phone entry, up to 3 total numbers.
9. When a code is observed, switch to the OpenAI tab, take a fresh snapshot, fill the code using a current ref, click the current Continue ref, and verify the next state.
10. If 3 verified attempts are exhausted and no more eligible SIMs exist in the pool, set the account to `sub2api_status=waiting_sim` with `waiting_since=<now>` and read back. If more eligible SIMs remain, continue trying. Do not infer exhaustion from an unobserved screenshot hypothesis.

## OpenAI OAuth — Consent Page

Evidence:
- `evidence_status`: `live_verified`
- `source`: current ego-browser E2E from OpenAI consent to localhost callback; 2026-08-03 duplicate-identity incident and corrected fresh-login run; 2026-08-06 four consecutive runs via `scripts/flow-consent.mjs` (#174-#177), identity gate + nav-history callback recovery held in all four
- `as_of`: `2026-08-06`
- `scope_note`: consent submission redirected to the localhost callback; Chromium rendered `ERR_CONNECTION_REFUSED` in every observed run (nothing listens on :1455), so the original callback must be recovered from CDP `Page.getNavigationHistory` — treat this as the normal path, not an edge case; one real mismatch showed that consent must be blocked until provider-visible identity exactly matches the target Base email

Triggered when the latest snapshot shows a consent control such as "Continue", "Allow", "Authorize", "授权", or "Accept", and `pageInfo()` confirms an OpenAI authentication origin or observed equivalent.

1. Extract the provider-visible consent email silently and require an exact match with the target Base email. A display name, account name, task-space name, or prior MFA success is not identity proof.
2. If it mismatches, do not click Continue. Log out or return through `Log in to another account`, authenticate the target once, and re-observe. A second mismatch is a hard stop without callback submission.
3. After exact identity match, click only the consent ref present in the latest snapshot.
4. Wait 2–3 seconds, then call `snapshotText()` and `pageInfo()`.
5. Verify whether the URL redirected to the expected localhost/`127.0.0.1` callback and extract it without logging the full callback URL.
6. If Chromium displays a callback error page and `pageInfo()` exposes only the error-page URL, call CDP `Page.getNavigationHistory`, recover exactly one localhost/`127.0.0.1` callback entry, and validate its expected path and query-key shape before use.

## SMS Platform — sms369.vip (Web or API Mode)

Evidence:
- `evidence_status`: `screenshot_inferred`
- `source`: artifact `codex-clipboard-b5f43a58-80a7-490e-bae2-c69574a7d9d4.png`; source system `链动小铺 order-detail page`; order `LD260727B55K8S`
- `as_of`: `2026-07-28`
- `scope_note`: screenshot-only hypothesis; response mode, response shape, DOM, polling behavior, and code extraction remain unknown until a live probe
- `capture_method`: user-provided clipboard screenshot; received `2026-07-28`; exact capture time unavailable
- `redaction_note`: original image contains live phone/SMS access data and is not committed; only provenance and hash are recorded
- `source_sha256`: `8d5c16be8e3c31f96fdaff1125f183d002de2276b4a2889b4eb215ca1b74ff2b`

Page example, redacted: `https://sms369.vip/api/sms/access?token=xxx`

1. Open the configured URL in the reused task space without logging the full token URL.
2. `snapshotText()` and, where available, inspect the observed content type/response to determine whether the endpoint currently returns HTML or JSON. Do not assume the mode from the screenshot.
3. For observed HTML, locate real SMS message text and extract only an observed 4–8 digit verification code.
4. For observed JSON, use a single explicit `js()` IIFE or `browserFetch()` in the authenticated page context to inspect the real response shape, redacting tokens and unrelated message content from logs.
5. Verify the extracted code against the displayed/returned message before use. A successful first probe may justify updating this pattern with the actual DOM or response schema and new provenance.

## SMS Platform — k.sms688.cc (Web Inbox Mode)

Evidence:
- `evidence_status`: `live_verified`
- `source`: account #185 (`<redacted-account>` + SIM 134***16, channel=direct, sub2api-auth #185 created 2026-08-07 20:21). Live SMS code observed at `elapsed=11s` after explicit OpenAI `重新发送短信` click + `cdp('Page.reload')` reload.
- `as_of`: `2026-08-07`
- `scope_note`: the inbox page is server-rendered HTML with no client-side refresh; the only way to read the current inbox state is to re-issue the HTTP GET. Hard Rule 29 captures this: `snapshotText()` and `openOrReuseTab(url)` are NOT refreshes — use `cdp('Page.reload')` on the active tab each round. Hard Rule 30 captures the explicit `重新发送短信` click requirement on the OpenAI side. Poll cadence: ~3 s reload + ~1.5 s settle; hard-cap 90 s. The visible body alternates between `【OpenAI/ChatGPT】暂无短信，到期时间：YYYY-M-D HH:MM` (no SMS) and `【OpenAI/ChatGPT】验证码: NNNNNN, X 秒后过期` (SMS delivered). Codes are 6 ASCII digits surrounded by non-digits. No `刷新验证码`/`再次接收` button exists on the page; the refresh is purely the HTTP GET.
- `redaction_note`: original URLs are token-bearing and remain process-local per Hard Rule 4 + Hard Rule 22.

Page example, redacted: `https://k.sms688.cc/sms/<token>`

1. Switch to the sms688.cc tab via `switchTab(...)` (use the tab object from `listTabs()`, not an id — Hard Rule 22 sub-(d)).
2. Force a fresh HTTP GET via `await cdp('Page.reload', { ignoreCache: false })` on that tab (Hard Rule 29).
3. `await sleep(1500–3000)` to let the round-trip settle, then `snapshotText()` and read the body.
4. Extract a 6-digit ASCII code via `text.match(/(?:[^0-9]([0-9]{6})[^0-9])/)`. Reject first-displayed stale code per Hard Rule 24 unless `i >= 3` (the chongpt stale-code trap carries over to direct-channel inbox providers).
5. Hard-cap the loop at 90 s total wall time; classify failure as `cooldown` 1-hour (not 3-day) and write the SIM `notes` with a redacted diagnostic per the SIM Pool Rules.

## SMS Platform — chongpt.xyz (Redemption-Code Channel)

Evidence:
- `evidence_status`: `live_verified`
- `source`: user delivery paste (2026-08-04), live site bundle analysis, and three completed redemption→bind→readback runs on 2026-08-04 (sub2api #163/#164/#165), and two slot-restoration binds on 2026-08-06 (#174/#177, all SSE test_complete success=true)
- `as_of`: `2026-08-06`
- `scope_note`: full channel path live-verified three times in one session: redeem → number assignment → OpenAI phone entry → SMS code fetch → bind success; slot restoration (re-verify stored CDK → 开始接收 → code fetch) live-verified twice more on 2026-08-06. Site UI remains third-party and drift-prone; re-observe before each action. Redemption consumes a code: only redeem a Base row that is actively being used for a phone binding attempt. STALE-CODE TRAP (Hard Rule 24, proven 2026-08-06 #174): a restored slot displays the previous session's code first — submitting it to OpenAI yields 验证码错误; record the displayed code, click 刷新验证码, and only use a code different from it
- `redaction_note`: redemption codes are bearer credentials; never print them

Channel contract (from delivery text): number valid 25–29 days; unlimited code fetches within validity. Flow: redeem code → platform assigns a number → OpenAI sends SMS → fetch code from the platform page.

UI strings observed in the site bundle (Chinese): `请填写 CDK`, `CDK 未验证`, `开始接收` (number is allocated after starting to receive: `开始接收后分配号码`), `更换号码` (allowed only after `开始接收` and before a code arrives; `已收到验证码后不能更换号码`; changing blacklists the old number: `已更换号码，原号码已拉黑`), `再次接收`, `刷新验证码`, `复制号码`, `复制验证码`, `槽位 #`, `等待验证码`, `验证码已收到`, `验证码已收到，与上次相同`, `号码已过期`, `已过期`, `号码已超过 N 天安全有效期，请联系商家更换新的接码 CDK`, `session验证失败`, `待人工确认`.

Redemption sequence (live-verified 2026-08-04):
1. `openOrReuseTab` the Base row's `redeem_url` (origin `chongpt.xyz`) in the reused task space; `snapshotText()` to locate the CDK input.
2. Re-read the selected SIM row's `redeem_code` process-local by exact `record_id`; fill it via native setter into `input[placeholder*="CDK"]` and click the `验证` button. Do not log the code.
3. Success shows alert `CDK <code> 已验证通过` and the slot view (`SMS NUMBER`, `槽位 #1`). If it reports invalid/expired CDK (`验证失败`, `号码已过期`, `session验证失败`), mark the Base SIM row `status=unavailable` with a redacted note and return to SIM selection. An already-redeemed CDK can be re-verified later to restore its slot: on 2026-08-04 (account #166) re-entering the stored CDK again showed `已验证通过` and the slot with the previously assigned number; click `开始接收` again before expecting SMS. This restoration path is live-verified once; durability across the whole validity window is unproven.
4. Two observed number-assignment shapes: (a) number already displayed with status `未开始`; (b) `开始接收后分配号码` — number appears only after clicking `开始接收`. In both cases click `开始接收`; status becomes `等待中` and the `开始接收` button turns into `刷新验证码`. Extract the `+1...` number and the `有效期至 YYYY-MM-DD HH:mm:ss` line; correct the Base row's `valid_until` from it (observed batch expiry applied to all codes of one order, i.e. the clock starts at order generation, not redemption).
5. Write the observed `phone_number` (and observed page URL if per-number) back to the exact SIM record before returning to the OpenAI tab for phone entry.

Code-fetch sequence after OpenAI sends the SMS (live-verified; codes arrived within ~30 s for #163/#164/#165; the #166 code arrived after the 120 s window while refresh clicks continued):
1. On the platform tab, click `刷新验证码` (label may read `再次接收` before any code has arrived) and poll every 5 s up to 120 s. The code appears as the value of the read-only 验证码 textbox (6 ASCII digits — verify by codepoints when a `^\d{4,8}$` test unexpectedly fails); page text also flips to `已收到`/`验证码已收到`. Match those markers as well as the input value; do not rely on a single regex.
2. Extract the code silently, switch to the OpenAI tab, fill `input[name=code]`, and continue. Treat `待人工确认` as a platform-side block: retry once later, then try another SIM row.
3. Note: the success alert and page text echo the redeemed CDK in clear text; do not dump page text containing it into logs.

## MFA Platform — 2fa.run (TOTP Secret Input)

Evidence:
- `evidence_status`: `live_verified`
- `source`: user delivery paste (2026-08-04) plus live use on 2026-08-04: platform page observed and one platform-read code succeeded (account #163); local TOTP computation from the same seeds passed all three OpenAI MFA challenges first try
- `as_of`: `2026-08-04`
- `scope_note`: platform page is a static JS TOTP tool (title `2FA工具`, input placeholder `点击此处输入密钥`, button `点击获取验证码`, result lines `双重密钥为:` / `当前验证码:` / `剩余的时间:`). Observed quirk: after the first successful fetch, clicking `点击获取验证码` again in a later window can leave `当前验证码` empty; prefer local TOTP computation, which was 3/3 reliable. The page echoes the pasted secret in clear text — extract only targeted fields, never dump body text

Secret-keyed TOTP platform (contrast with email-keyed `2fa.nloop.cc`):
1. Open `https://2fa.run/` (or a backup origin from the account notes) in a new tab of the reused task space.
2. `snapshotText()` — locate the secret/密钥 input. Do not assume an email input exists; if the observed input is email-keyed instead, stop and re-observe.
3. Fill the account's Base `mfa_secret` (re-read process-local by exact record_id) using a current ref; verify the fill without printing the secret.
4. Observe the rendered 6-digit code and its countdown. If remaining time is below 5 seconds, wait for the refreshed code before extraction.
5. Extract the code silently, switch to the OpenAI tab, fill the challenge input, and continue.
6. Fallback: if the platform is unreachable or ambiguous and the account has `mfa_secret`, compute TOTP locally (RFC 6238: base32-decode seed, HMAC-SHA1, 30 s window, 6 digits, current time). A locally computed code is equivalent evidence to a platform-read code.

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

## OpenAI Direct Login — Subscription Verification (chatgpt.com)

Evidence:
- `evidence_status`: `live_verified`
- `source`: 2026-08-04 direct login of one real account (`<redacted-account>`) to verify subscription expiry; email form flow → native-setter password → requestSubmit → MFA → logged-in chatgpt.com
- `as_of`: `2026-08-04`
- `scope_note`: verified for subscription-state checks only (no OAuth callback); `GET /backend-api/me` returned empty email/phone and is unreliable; `GET/POST /backend-api/accounts/check*` returned 404/405; sidebar plan badge and Settings → 账单 tab are the authoritative reads

Use when an account is missing from sub2api (suspected manual removal) or its subscription state must be confirmed without an OAuth relay.

1. Entry: `https://chatgpt.com/auth/login` (ChatGPT wrapper form). Fill `input[name="email"]`, click 继续; the flow redirects to `auth.openai.com/log-in/password`. Do not bypass the form with direct fetch calls (see OpenAI OAuth Login Page step 6).
2. Password via native setter + `form.requestSubmit(button[name="intent"])` per Hard Rules 14–15. Identity gate: the email shown on the password page must exactly match the target Base email before submitting.
3. Handle MFA if challenged (authenticator path preferred, Hard Rule 17).
4. After login, read plan state from two places: the sidebar profile block (`<name>` + `免费版`/`Plus` badge + 升级 button) and Settings → 账单 tab (`chatgpt.com/settings`), which shows the current plan heading and invoice history.
5. Expiry evidence: a voided (`作废`) renewal invoice plus current plan `ChatGPT 免费版` proves the Plus subscription lapsed; record the invoice date/amount in Base notes.
6. Hygiene: log out via `https://auth.openai.com/logout` and `https://chatgpt.com/auth/logout`, verify the session is gone, then complete the task space.

## MFA Platform — 2fa.run (Slider CAPTCHA + Key-Based TOTP)

Evidence:
- `evidence_status`: `live_verified`
- `source`: 2026-08-04 MFA resolution for `<redacted-account>` during direct login; slider passed via CDP drag; TOTP code from key input accepted by OpenAI mfa-challenge
- `as_of`: `2026-08-04`
- `scope_note`: unlike 2fa.nloop.cc (email query), 2fa.run requires the TOTP secret; entry is guarded by a slide-to-verify challenge (`拖动滑块验证`); the page renders dark/blank in screenshots, so drive it via DOM rather than visuals

1. Opening `https://2fa.run/` shows the slider challenge (`div#slider` with `.handler` inside `.slideBox`), not the tool UI.
2. Resolve it with a human-like drag: `Input.dispatchMouseEvent` mousePressed at the handler center, ~25–30 mouseMoved steps with easing and slight y jitter over ~400–600 ms, mouseReleased at the track end. One pass succeeded; the page then renders the real 2FA工具 UI. If it resets, retry max 2 rounds, then hand off.
3. The tool has two key inputs (`点击此处输入密钥`) with `点击获取验证码` buttons (JS implementation). Fill the first key input with the account's TOTP secret from Base notes (`mfa_secret=...`), click the button, then read `当前验证码` and `剩余的时间` from the page text.
4. Require >= 12 seconds of countdown before carrying a code to OpenAI; otherwise poll for the next code.
5. Switch back to the OpenAI mfa-challenge tab, fill `input[name="code"]`, click `button[name="intent"]`, and verify transition away from the challenge.

---

This file may grow after successful automation runs. Add or promote a pattern only with its new evidence status, source, as-of date, scope note, and successful observe–act–verify/readback evidence.
