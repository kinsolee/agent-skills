# OpenCodex Management API behind Cloudflare Access

evidence:
- `evidence_status`: `live_verified`
- `source_system`: private OpenCodex deployment and installed OpenCodex source
- `captured_at`: `2026-08-12T06:45:59Z`
- `endpoint_method`: `GET /api/providers`
- `provenance`: Cloudflare Access service-token headers plus OpenCodex management-token header; response cross-checked against `src/server/management-auth.ts` and `src/server/management/provider-routes.ts`
- `redaction_notes`: deployment hostname, LAN addresses, credential values, provider API keys, stored header names/values, response body, and Cloudflare redirect parameters are omitted
- `source_sha256`: `b9b810c0a482712293c5016a6d9e5ccd4b4f0f6b38c99b433848da8fa8084a30` (raw successful JSON response)

account-pool evidence:
- `evidence_status`: `live_verified`
- `captured_at`: `2026-08-12T11:36:00Z`
- `endpoint_method`: `GET /api/codex-auth/accounts?refresh=1` plus `DELETE /api/codex-auth/accounts?id=…` and the full login/status/submit flow chain
- `provenance`: public management API with all three auth headers; eight `refresh_failed` rows were each classified through real isolated OpenAI OAuth flows — four confirmed `account_deactivated` and deleted with readback, four reauthorized end to end (callback submitted, credential persisted, same-account force-refresh returned `healthy`)
- `redaction_notes`: deployment hostname, LAN addresses, account counts and identities, OAuth URLs, flow IDs, callback URLs, request IDs, passwords, MFA values, and credential values are omitted
- `source_sha256`: `a421aa1c3f3f8d42b4cc608a3baf8c13e12c8eed47854ea22e2df98e5b1138d7` (raw successful account JSON response)
- `live_verified_scope`: inventory/force-refresh response, flow start/login, explicit `account_deactivated`, unavailable-second-factor failure branches, `DELETE` of terminal accounts with pool readback, callback submission, credential persistence, same-account fresh-health success after reauthorization, and data-plane `/v1/models` + streaming `/v1/responses` acceptance (the deployment requires `stream: true`; `stream: false` returns 400 `Stream must be set to true`)
- `not_live_verified`: none for the documented reauthorization path; two flows ended in a non-terminal `oauth_error` after an accepted submission and succeeded on a fresh retry, so treat that state as transient, never as account deactivation

data-plane evidence boundary:
- `evidence_status`: `live_verified` separately from account reauthorization
- `scope_note`: model listing and one completed Responses request were observed on the configured data plane; that proves the gateway path at that time, not which pool account served it and not that the new reauthorization driver persisted credentials
- `snapshot_note`: no reusable raw response snapshot is present in this repository; re-run the acceptance checks for current evidence

## Authentication boundary

Treat Cloudflare Access, OpenCodex management, and OpenCodex data-plane authentication as separate gates:

| Gate | Request header | Environment variable | Local source |
|---|---|---|---|
| Cloudflare Access | `CF-Access-Client-Id` | `CF_ACCESS_CLIENT_ID` | `~/.codex/secrets/opencodex-provider.env` |
| Cloudflare Access | `CF-Access-Client-Secret` | `CF_ACCESS_CLIENT_SECRET` | `~/.codex/secrets/opencodex-provider.env` |
| OpenCodex management `/api/*` | `x-opencodex-api-key` | `OCX_ADMIN_AUTH_TOKEN` | project `.env` |
| OpenCodex data plane `/v1/*` | `x-opencodex-api-key` | `OPENCODEX_API_AUTH_TOKEN` | `~/.codex/secrets/opencodex-provider.env` |

Use `OCX_ADMIN_AUTH_TOKEN` for `/api/providers`. The data-plane token is a different credential and does not satisfy management authentication. Never print, persist, hash for reporting, or commit any credential value.

The active Codex provider config is `~/.codex/config.toml`:

```toml
[model_providers.opencodex]
base_url = "https://<opencodex-host>/v1"
env_http_headers = {
  "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN",
  "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID",
  "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET"
}
```

Derive the management origin by removing the terminal `/v1` from the active `base_url`, then append the `/api/*` route. Keep deployment hostnames and LAN addresses only in gitignored local configuration. Loopback service-listener and health-check references may remain because they describe protocol-local operation rather than a user-specific network address.

## Provider readback

Run from the repository root:

```bash
node skills/sub2api-auth/scripts/opencodex-providers.mjs
```

The script performs only `GET /api/providers`. It loads the Cloudflare values from the Codex secret environment file, loads the management token from the gitignored project `.env`, and outputs this allowlist per provider:

- `name`, `adapter`, `defaultModel`, and a boolean indicating whether a base URL is configured
- boolean credential/header presence flags, never their values
- network, live-model, disabled, and auth-mode flags
- configured model count and sanitized discovery status

Accept the probe only when the response is HTTP 200 JSON and the root value is an array. Classify failures by layer:

- `302`: Cloudflare Access did not accept the service token; inspect credential presence and Access policy without printing redirect parameters.
- `401`: Cloudflare passed the request, but the OpenCodex management token was absent or rejected.
- `200` with an array: management authentication and provider readback succeeded.

Treat provider names, counts, models, health, and discovery state as time-sensitive and deployment-private; always re-run the probe instead of persisting a live inventory in version-controlled documentation.

`GET /api/providers` is intentionally safe for inventory: OpenCodex returns only `hasApiKey` and `hasHeaders` presence booleans. It does not return provider API keys or stored header names/values. Do not generalize this read authorization into permission for POST, PATCH, PUT, or DELETE management calls.

## OpenAI account-pool patrol

Run from the repository root:

```bash
node skills/sub2api-auth/scripts/opencodex-account.mjs check --refresh
```

The `--refresh` gate is mandatory for a real patrol. It calls `GET /api/codex-auth/accounts?refresh=1`, which makes OpenCodex validate/refresh each stored credential and probe the upstream WHAM usage endpoint. Treat an account as requiring OAuth only when the fresh result has `needsReauth=true` or `health.status="reauth_required"`. Treat `quotaProbeSkipped=true`, lock contention, quota cooldown, or an ordinary transient upstream error as non-terminal and re-probe; they are not evidence of revoked authorization.

Require all of these before declaring a healthy account:

- `hasCredential=true`
- `needsReauth=false`
- `health.status="healthy"` (or another explicitly non-reauth operational state whose reason is understood)
- the force-refresh was not skipped

Account counts, identities, and health are time-sensitive and deployment-private. Always re-run the driver and keep live fleet details in the current task output rather than version-controlled documentation.

### `refresh_failed` is frequently `account_deactivated`

The patrol reports `health.status="reauth_required"` / `reason="refresh_failed"` for both a merely-expired token and a permanently-deactivated account — it cannot distinguish them. Empirically a large share are terminal: **2026-08-12 4/8 and 2026-08-13 4/4** `refresh_failed` targets were `account_deactivated`. The only discriminator is a login probe: run the account's OAuth flow and observe OpenAI's response. Route by Base credential shape (Hard Rule 33):

- Base `password` set → `scripts/flow-login.mjs` (+ MFA per Hard Rule 17/27).
- Base `password` empty, `email_helper_url` set → `scripts/flow-email-login.mjs` (passwordless email-code; `references/ichzl-email-helper-api.md`).

A correct credential that OpenAI accepts but then surfaces `account_deactivated` (on the same `/email-verification` or post-password page) is terminal — the login itself succeeded; do not retry. A correct credential that reaches the consent/callback page is reauthorizable: finish via `flow-opencodex-consent.mjs`.

### Cross-platform credential ownership

Treat Sub2API and OpenCodex as independent OAuth credential owners even when both contain the same OpenAI identity. Do not copy or share refresh tokens between them. A successful refresh can rotate a grant and leave the other platform holding an older generation.

The 2026-08-12 live comparison found multiple overlapping identities for which Sub2API completed a real upstream usage probe while OpenCodex returned `refresh_failed`. This is strong evidence of credential-generation divergence, but it does not prove the stored tokens were equal or capture the exact rotation response. Verify each platform separately and reauthorize each platform through its own full OAuth persistence flow.

### Identity resolution for pool accounts

`GET /api/codex-auth/accounts` masks every identity with the deployment's `maskEmail` (first local character + `***` + last local character + domain; shorter locals mask further). There is no unmask parameter and no other management route returns full identities. Matching a masked email against a credential book by first/last character is only a hypothesis — it can suggest candidates but never proves identity.

Authoritative read-only resolution: on the deployment host, `~/.opencodex/config.json` → `codexAccounts[]` holds `{ id, email, plan, isMain, logLabel }` for the whole pool, while `~/.opencodex/codex-accounts.json` holds only tokens (`credential: { accessToken, refreshToken, expiresAt, chatgptAccountId }`) and no emails. Resolve pool id → full email in-process over SSH and emit only masked identities (Hard Rule 4). Live-verified 2026-08-12: all eight `refresh_failed` targets mapped to their Feishu Base records this way after masked-email matching had produced zero results.

## OpenCodex reauthorization

Process one account at a time because the underlying ChatGPT OAuth flow is provider-global. The canonical driver always locks `~/.opencodex/oauth-flows/.opencodex-reauth.lock`, independent of the selected auth-file name. The runtime directory is mode `0700`; lock and auth files are mode `0600`; auth files are direct children of that directory and therefore outside the repository. Do not bypass the lock with direct API calls or a second UI flow. A stale lock is recovered only when its owner PID is dead and its age exceeds the 30-minute TTL; a live, recent, malformed, or unsafe-permission lock fails closed.

1. Create a protected flow file outside the repository:

   ```bash
   node skills/sub2api-auth/scripts/opencodex-account.mjs start \
     --id <existing-pool-id> --auth-file ~/.opencodex/oauth-flows/<opaque-name>.json
   ```

2. Run the existing `flow-login.mjs` with the matching Base record, task-space ID, and auth file. Choose MFA using the same MFA-first host rules as Sub2API.
3. At consent, run `flow-opencodex-consent.mjs`. It records a navigation baseline before the identity gate, verifies the exact Base email, clicks consent, and accepts only a later navigation. In-process parsing requires HTTP loopback host `localhost` or `127.0.0.1`, exact `/auth/callback`, and exactly one non-empty `code` and `state`; an explicit error callback fails closed. `start` hashes a unique `state` from the protected auth URL when available and the consent/submit paths require that hash to match. If the auth URL has no directly derivable state, local binding is unavailable and the pending server flow performs the authoritative flow/state validation; do not describe that branch as locally state-bound. Callback material enters neither argv nor emitted output.
4. Any identity, consent, callback-validation, browser, or submit failure invokes canonical `cancel`, which attempts the server cancellation and always clears the local auth file and matching lock. Emit only the non-sensitive outcome and whether cleanup completed.
5. Poll `opencodex-account.mjs status --auth-file ...` until the flow reports `done`, then immediately run `check --refresh` and require the same pool ID to be healthy with a persisted credential. This success sequence is live-verified 2026-08-12 on four pool accounts. A non-terminal `oauth_error` at this stage is transient: local state is already sanitized, so restart the flow from `start` and retry once before escalating.
6. `status` sanitizes the auth file and releases the driver lock when the remote flow reaches `done`, `error`, or `expired`; these are flow-lifecycle cleanup states, not terminal account classifications. Only an explicit OpenAI `account_deactivated` result is terminal for the account. After cleanup, close the dedicated task space and read back that the auth file is zero bytes and the fixed lock is absent.

OpenCodex enforces same-identity reauth: a different ChatGPT identity is rejected rather than overwriting the trusted pool slot. A pending flow must exist before callback submission; manual callback submission is not a way around flow creation.

If the live OpenAI page explicitly reports `account_deactivated`, classify it as terminal and stop retrying. `needsReauth` alone does not prove deactivation. Removing the terminal row from the OpenCodex pool deletes its stored credential and is a separate destructive action; require explicit deletion authorization unless the user's standing policy already covers it. The canonical driver now supports it:

```bash
node skills/sub2api-auth/scripts/opencodex-account.mjs delete --id <pool-id>   # DELETE /api/codex-auth/accounts?id=<id>; 200/202/204 = removed
```

Verify removal by re-running `check --refresh` and requiring the id to be absent and `accountCount` to drop. Live-verified 2026-08-13: four `account_deactivated` rows deleted (18 → 14), all ids confirmed absent on readback.

If password validation succeeds but the account needs a second factor, exhaust MFA first. If the MFA lookup has no row and no Base seed, use `flow-email-otp.mjs` only after OpenAI offers email OTP and pass a challenge-start timestamp captured at issuance/navigation. OpenAI's challenge HTTP 200 proves only that the send request was accepted. The observed helper contract does not establish recipient or delivery-time field names, so the current adapter intentionally fails closed; not-found proves only that the helper cannot retrieve the message. Do not convert receive-channel failure into `account_deactivated`, guess a field/code, or delete the pool row. Canonically cancel and retry when an exact-identity channel has sufficient metadata.

## Separately live-verified data-plane acceptance

Account health is management-plane evidence, not end-to-end gateway acceptance. Conversely, the separately live-verified data-plane request does not prove callback submission, credential persistence, fresh account health, or successful reauthorization. After every patrol or future successful reauth:

1. Call `/v1/models` with Cloudflare Access headers plus `OPENCODEX_API_AUTH_TOKEN` and require HTTP 200.
2. Call `/v1/responses` using a currently listed OpenAI model and require HTTP 200, a `response.completed` event, no `response.failed`/`response.incomplete`, and the expected output marker.
3. For OpenCodex 2.11.0, send `input` as a Responses message list; the string shorthand returns HTTP 400 `Input must be a list`.
4. The deployment requires `stream: true` on `/v1/responses`; `stream: false` returns HTTP 400 `Stream must be set to true`. Parse the SSE stream for `response.completed` and the output marker (proven 2026-08-12).

Successful model listing alone does not prove generation or account-pool delivery.

## Local loopback deployment shape (2026-08-16, live-verified)

A local OpenCodex instance (`bun @bitkyc08/opencodex` listening on `http://127.0.0.1:10100`, discovered via `openai_base_url` in `~/.codex/config.toml`) differs from the Cloudflare-Access deployment in four verified ways:

- **Management origin is plain HTTP, loopback-only.** `managementOrigin()`/`managementEndpoint()` accept `http:` only for `localhost`/`127.0.0.1`/`::1`; non-loopback origins still fail closed on non-HTTPS. `OCX_ADMIN_BASE` in the project `.env` points at the loopback origin.
- **The management token is the instance's own `~/.opencodex/admin-api-token`.** A token from another deployment (e.g. the previous LAN instance) returns 401; sync it into `OCX_ADMIN_AUTH_TOKEN` process-locally and never print it. The Cloudflare Access headers are still required by the driver's `required()` gate but are ignored by the local instance.
- **`POST /api/codex-auth/login` opens the system default browser server-side** (`src/codex/auth-api.ts` → `openUrl(result.url)` → macOS `open`). Every `start --add`/`start --id` pops the auth page in the user's default browser (e.g. Edge) — redundant with the ego-browser flow, unconditional, and without a config switch. Users must not interact with that page (it can consume the OAuth code of the pending flow).
- **`--add` batch-proven at scale.** 2026-08-16: 22 Base-`active` accounts processed one at a time; 14 added and healthy (`start --add` → `flow-login` → `flow-mfa`/`flow-totp-local` → `flow-opencodex-consent` → `status` → `check --refresh`), 7 terminal `account_deactivated` at the password step (`错误代码：account_deactivated` on `/log-in/password`), 1 parked after two accepted-callback `oauth_error` exchanges failed to persist. A post-persist transient `oauth_error` in `status` does NOT prove failure — verify the pool (`check`) before retrying; two accounts succeeded despite it. The earliest-added accounts can show `refresh_failed` on the next patrol when another platform (Sub2API heartbeat) rotates the same OpenAI grant — fix with the normal `start --id` reauth flow, after which the pool returned to 15/15 healthy.
