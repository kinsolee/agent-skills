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

## sub2api Admin — Login

Evidence:
- `evidence_status`: `live_verified`
- `source`: historical sub2api automation, latest relevant commit `9aca6f1`
- `as_of`: `2026-05-12`
- `scope_note`: historical live verification used a different host; it does not validate the current host, so take a fresh snapshot on `<sub2api-host>` before the first current action and treat UI drift as possible

Page: `SUB2API_ADMIN_URL` (default `http://<sub2api-host>:8080/admin/accounts`)

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
- `source`: current-host ego-browser E2E on sub2api `<sub2api-host>:8080`
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
- `source`: current-host ego-browser E2E on sub2api `<sub2api-host>:8080`
- `as_of`: `2026-07-28`
- `scope_note`: one real callback submission created the account and passed unique-row, `正常` status, configured group/proxy, and empty-remark readback

Prerequisite: account dialog remains open and the OpenAI flow returned a callback URL.

1. `snapshotText()` — locate the input labeled "授权链接", "Code", "Authorization URL", or "Callback".
2. `fillInput` using a ref from that snapshot, without logging the callback URL; then take a fresh snapshot to verify field state.
3. Click the current "完成授权" or equivalent submit ref.
4. Require the dialog to close and an account-created success signal.
5. Search for the exact account identifier, require exactly one matching row with status `正常`, then open its edit dialog and require the remark field to be empty.

## OpenAI OAuth — Login Page

Evidence:
- `evidence_status`: `live_verified`
- `source`: current ego-browser E2E from sub2api authorization URL through OpenAI MFA and consent
- `as_of`: `2026-07-28`
- `scope_note`: one real path verified email login, password login, MFA transition, and continuation to consent; OpenAI UI remains drift-prone, so re-observe before every action

Page: authorization URL generated by sub2api. Do not log the full URL.

1. In the reused task space, `openOrReuseTab(authUrl, { wait: true })`.
2. Wait 3 seconds for page load and a possible Cloudflare challenge.
3. `snapshotText()` — if a Cloudflare or CAPTCHA challenge is present, follow the "CAPTCHA & Cloudflare Automation" pattern below. Only after all automated rounds are exhausted should the agent hand off the task space.
4. From the latest snapshot, find the email input (`input[name="username"]`, `input[type="email"]`, or observed equivalent), fill the account email, and observe again.
5. Click the current Continue/Next/继续 ref; wait 2–3 seconds and take a fresh snapshot.
6. If "Continue with password", "使用密码继续", or "Use password instead" appears, click its current ref and observe again.
7. Locate the password input in the latest snapshot, fill the redacted account password, and observe again without exposing it.
8. Click the current Continue/Log in/登录 ref, wait 2–3 seconds, then `snapshotText()` and `pageInfo()` to determine the next state: MFA, email verification, phone binding, consent, or callback redirect.

## OpenAI OAuth — MFA Verification (2fa.nloop.cc)

Evidence:
- `evidence_status`: `live_verified`
- `source`: current ego-browser E2E against `2fa.nloop.cc`
- `as_of`: `2026-07-28`
- `scope_note`: one real account query produced exactly one TOTP result with a countdown and code button, and the submitted code transitioned OpenAI to consent; zero/multiple-result behavior and the email-helper fallback remain unverified
- `prior_source`: artifact `codex-clipboard-85456eba-d2dd-486e-9c02-863d00ebc6c3.png`; source system `链动小铺 order-detail page`; order `LD26072731CVWM`
- `prior_source_sha256`: `3aca992604ab571a012576ea7ce4816aa543109209ab8ce856e383a385fbe184`

Verified trigger: the latest OpenAI snapshot shows the authenticator challenge and a code input such as `input[name="code"]`, and the account record has `mfa_platform_url`.

1. Normalize the Base URL cell before browser use. When it is a Markdown link, prefer the parenthesized target; validate the expected HTTPS origin and do not print the URL.
2. Open the configured MFA platform URL in a new tab within the same task space.
3. `snapshotText()` — locate the query input in the `粘贴邮箱` panel. If absent, stop this pattern and re-observe.
4. Fill the account email using a ref from the latest snapshot, wait 2–3 seconds, and take a fresh snapshot.
5. Require the page to report exactly one result. Stop on zero or multiple results rather than guessing.
6. Require one six-digit code button and an observed countdown. If the remaining time is below 5 seconds, wait for and verify a refreshed code before extraction.
7. Extract the code silently, switch back to the existing OpenAI tab, take a fresh snapshot, fill the code using a current ref, and observe again.
8. Click the current Continue/Verify/验证 ref, then require a transition away from the MFA challenge.

Hypothesized fallback only: if no MFA result appears, the historical script suggests an email helper at `email.nloop.cc` using the same-tab-space multi-tab approach. Its current UI and behavior require separate observation before any action.

## OpenAI OAuth — Phone Binding

Evidence:
- `evidence_status`: `screenshot_inferred`
- `source`: artifact `codex-clipboard-b5f43a58-80a7-490e-bae2-c69574a7d9d4.png`; source system `链动小铺 order-detail page`; order `LD260727B55K8S`
- `as_of`: `2026-07-28`
- `scope_note`: screenshot-only hypothesis; phone-entry, rejection, retry, and SMS-delivery behavior are not live-verified and must be observed before each action. The successful `2026-07-28` E2E did not request phone verification, so it provides no live evidence for this pattern
- `capture_method`: user-provided clipboard screenshot; received `2026-07-28`; exact capture time unavailable
- `redaction_note`: original image contains live phone/SMS access data and is not committed; only provenance and hash are recorded
- `source_sha256`: `8d5c16be8e3c31f96fdaff1125f183d002de2276b4a2889b4eb215ca1b74ff2b`

Hypothesized trigger: the latest snapshot or screenshot shows "phone number", "Check your phone", "Enter the verification code we just sent to", "添加电话号码", or a phone input.

1. Query Feishu Base for currently available SIM cards; use only authorized real records and preserve their provenance.
2. Pick the best number according to the verified SIM-pool rules; do not invent a number or status.
3. `snapshotText()` — locate the phone input and observe actual country-code handling before acting. Do not assume whether a dropdown or `+1` prefix exists.
4. Fill the number using a current ref, observe again, click the current Continue/Send code ref, wait 3 seconds, and verify the resulting OpenAI state.
5. Open the configured SMS URL in a new tab in the same task space without logging the full token URL.
6. For at most 120 seconds, every 5 seconds take a fresh SMS-tab snapshot and inspect the actual response for a 4–8 digit code. Do not reuse refs across snapshots.
7. If the observed provider/OpenAI response identifies the number as rejected (for example, "无法向此号码发送验证码" or "This phone number was recently used"), return `PHONE_REJECTED`.
8. On `PHONE_REJECTED`, update the real SIM record to recoverable `status=cooldown` and `cooldown_until=now+1 hour`; never mark it permanently unavailable. Read back both fields, choose another eligible number, and retry from phone entry, up to 3 total numbers.
9. When a code is observed, switch to the OpenAI tab, take a fresh snapshot, fill the code using a current ref, click the current Continue ref, and verify the next state.
10. If 3 verified attempts are exhausted and no more eligible SIMs exist in the pool, set the account to `sub2api_status=waiting_sim` with `waiting_since=<now>` and read back. If more eligible SIMs remain, continue trying. Do not infer exhaustion from an unobserved screenshot hypothesis.

## OpenAI OAuth — Consent Page

Evidence:
- `evidence_status`: `live_verified`
- `source`: current ego-browser E2E from OpenAI consent to localhost callback
- `as_of`: `2026-07-28`
- `scope_note`: one real consent submission redirected to the localhost callback; Chromium rendered `ERR_CONNECTION_REFUSED`, so the original callback was recovered from navigation history

Triggered when the latest snapshot shows a consent control such as "Continue", "Allow", "Authorize", "授权", or "Accept", and `pageInfo()` confirms an OpenAI authentication origin or observed equivalent.

1. Click only the consent ref present in the latest snapshot.
2. Wait 2–3 seconds, then call `snapshotText()` and `pageInfo()`.
3. Verify whether the URL redirected to the expected localhost/`127.0.0.1` callback and extract it without logging the full callback URL.
4. If Chromium displays a callback error page and `pageInfo()` exposes only the error-page URL, call CDP `Page.getNavigationHistory`, recover exactly one localhost/`127.0.0.1` callback entry, and validate its expected path and query-key shape before use.

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

---

This file may grow after successful automation runs. Add or promote a pattern only with its new evidence status, source, as-of date, scope note, and successful observe–act–verify/readback evidence.
