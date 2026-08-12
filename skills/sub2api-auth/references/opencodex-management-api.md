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
- `captured_at`: `2026-08-12T07:18:23Z`
- `endpoint_method`: `GET /api/codex-auth/accounts?refresh=1`
- `provenance`: public management API with all three auth headers; four returned `refresh_failed` rows were each checked through a real isolated OpenAI OAuth flow
- `redaction_notes`: deployment hostname, LAN addresses, account counts and identities, OAuth URLs, flow IDs, callback URLs, request IDs, passwords, MFA values, and credential values are omitted
- `source_sha256`: `a421aa1c3f3f8d42b4cc608a3baf8c13e12c8eed47854ea22e2df98e5b1138d7` (raw successful account JSON response)
- `live_verified_scope`: inventory/force-refresh response, flow start/login, explicit `account_deactivated`, and unavailable-second-factor failure branches
- `not_live_verified`: callback submission, credential persistence, and a same-account fresh-health success after reauthorization

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

### Cross-platform credential ownership

Treat Sub2API and OpenCodex as independent OAuth credential owners even when both contain the same OpenAI identity. Do not copy or share refresh tokens between them. A successful refresh can rotate a grant and leave the other platform holding an older generation.

The 2026-08-12 live comparison found multiple overlapping identities for which Sub2API completed a real upstream usage probe while OpenCodex returned `refresh_failed`. This is strong evidence of credential-generation divergence, but it does not prove the stored tokens were equal or capture the exact rotation response. Verify each platform separately and reauthorize each platform through its own full OAuth persistence flow.

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
5. Poll `opencodex-account.mjs status --auth-file ...` until the flow reports `done`, then immediately run `check --refresh` and require the same pool ID to be healthy with a persisted credential. This success sequence is required acceptance but is not yet live-verified.
6. `status` sanitizes the auth file and releases the driver lock when the remote flow reaches `done`, `error`, or `expired`; these are flow-lifecycle cleanup states, not terminal account classifications. Only an explicit OpenAI `account_deactivated` result is terminal for the account. After cleanup, close the dedicated task space and read back that the auth file is zero bytes and the fixed lock is absent.

OpenCodex enforces same-identity reauth: a different ChatGPT identity is rejected rather than overwriting the trusted pool slot. A pending flow must exist before callback submission; manual callback submission is not a way around flow creation.

If the live OpenAI page explicitly reports `account_deactivated`, classify it as terminal and stop retrying. `needsReauth` alone does not prove deactivation. Removing the terminal row from the OpenCodex pool deletes its stored credential and is a separate destructive action; require explicit deletion authorization unless the user's standing policy already covers it.

If password validation succeeds but the account needs a second factor, exhaust MFA first. If the MFA lookup has no row and no Base seed, use `flow-email-otp.mjs` only after OpenAI offers email OTP and pass a challenge-start timestamp captured at issuance/navigation. OpenAI's challenge HTTP 200 proves only that the send request was accepted. The observed helper contract does not establish recipient or delivery-time field names, so the current adapter intentionally fails closed; not-found proves only that the helper cannot retrieve the message. Do not convert receive-channel failure into `account_deactivated`, guess a field/code, or delete the pool row. Canonically cancel and retry when an exact-identity channel has sufficient metadata.

## Separately live-verified data-plane acceptance

Account health is management-plane evidence, not end-to-end gateway acceptance. Conversely, the separately live-verified data-plane request does not prove callback submission, credential persistence, fresh account health, or successful reauthorization. After every patrol or future successful reauth:

1. Call `/v1/models` with Cloudflare Access headers plus `OPENCODEX_API_AUTH_TOKEN` and require HTTP 200.
2. Call `/v1/responses` using a currently listed OpenAI model and require HTTP 200, a `response.completed` event, no `response.failed`/`response.incomplete`, and the expected output marker.
3. For OpenCodex 2.11.0, send `input` as a Responses message list; the string shorthand returns HTTP 400 `Input must be a list`.

Successful model listing alone does not prove generation or account-pool delivery.
