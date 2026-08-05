# sub2API Admin API Reference

evidence:
- `evidence_status`: `source_verified`
- `source`: upstream Wei-Shaw/sub2api Go backend (`internal/server/routes/admin.go`, `internal/handler/admin/{account,openai_oauth}_handler.go`, `internal/service/openai_oauth_service.go`, `internal/pkg/openai/oauth.go`) and Vue frontend (`composables/useOpenAIOAuth.ts`, `ReAuthAccountModal.vue`, `CreateAccountModal.vue`); cross-checked live against the configured local instance via `sub2api-admin-api.mjs` (account list + generate-auth-url probes succeeded 2026-08-04)
- `as_of`: `2026-08-04`
- `scope_note`: this reference covers ONLY the endpoints used by the OpenAI OAuth account lifecycle. The backend exposes hundreds of admin routes; only those that replace the former browser-UI panel operations are documented here. `source_verified` means confirmed against source code, not an exhaustive live POST of every mutation.

## Authentication

All `/api/v1/admin/*` routes pass through the admin auth middleware
(`internal/server/middleware/admin_auth.go`). Two methods are accepted:

1. **Admin API Key** — `x-api-key: <admin-api-key>` header. This is the method
   the automation uses; it resolves to the first admin user and needs no browser
   login session. Configure `SUB2API_ADMIN_API_KEY` in `.env` (gitignored).
2. **JWT** — `Authorization: Bearer <jwt>` (admin role). Used by the panel.

A missing/invalid key returns `401 INVALID_ADMIN_KEY`.

## Response envelope

JSON endpoints return `{ "code": 0, "message": "success", "data": <payload> }`.
`code !== 0` indicates an error. The helper unwraps `data`.

The **test** endpoint is an exception: it returns an SSE stream, not JSON.

## OpenAI OAuth authorization URL + callback

### Generate auth URL
`POST /api/v1/admin/openai/generate-auth-url`

Request (all optional):
```json
{ "proxy_id": 5, "redirect_uri": "http://localhost:1455/auth/callback" }
```
When `redirect_uri` is omitted the backend uses
`http://localhost:1455/auth/callback` (`internal/pkg/openai/oauth.go` DefaultRedirectURI).
The URL embeds PKCE `code_challenge` (S256) and a `state`; the matching
`code_verifier` + `state` are held in an in-memory session keyed by `session_id`.

Response `data`:
```json
{ "auth_url": "https://auth.openai.com/oauth/authorize?...", "session_id": "<id>" }
```

### Exchange code for tokens
`POST /api/v1/admin/openai/exchange-code`

Validates the returned `code` + `state` against the session store (constant-time
`state` compare), exchanges via PKCE, deletes the session, and returns `tokenInfo`:
```json
{ "session_id": "...", "code": "...", "state": "...", "redirect_uri": "(opt)", "proxy_id": "(opt)" }
```
Response `data` (OpenAITokenInfo): `access_token`, `refresh_token`, `id_token`,
`expires_at`, `email`, `name`, `plan_type`, `subscription_expires_at`,
`chatgpt_account_id`, `chatgpt_user_id`, `organization_id`, `client_id`.

> A session is consumed by exactly one exchange. Do not call both `exchange-code`
> and `create-from-oauth` against the same `session_id`.

## New account creation (replaces the "添加账号" dialog)

The frontend (`CreateAccountModal.vue`) does NOT use the convenience
`create-from-oauth` endpoint. It splits the work so it can build the credentials
map and attach model mappings:

1. `generate-auth-url` → `auth_url` + `session_id`
2. (browser completes OpenAI OAuth, capture `code` + `state` from the callback)
3. `exchange-code` → `tokenInfo`
4. `buildCredentials(tokenInfo)` (client-side; see below)
5. `POST /api/v1/admin/accounts` with the full create payload

`buildCredentials` mirrors `useOpenAIOAuth.buildCredentials` — only non-empty
fields are included; `refresh_token` is written only when a new one is present
(prevents blanking an existing token):

| tokenInfo field | credentials field |
|---|---|
| access_token | access_token |
| expires_at | expires_at |
| refresh_token | refresh_token (only if present) |
| id_token | id_token |
| email | email |
| chatgpt_account_id | chatgpt_account_id |
| chatgpt_user_id | chatgpt_user_id |
| organization_id | organization_id |
| plan_type | plan_type |
| subscription_expires_at | subscription_expires_at |
| client_id | client_id |

`POST /api/v1/admin/accounts` create body (Go `CreateAccountInput`):
```json
{
  "name": "<email>",
  "platform": "openai",
  "type": "oauth",
  "credentials": { ...from buildCredentials... },
  "extra": { "email": "...", "name": "...", "privacy_mode": "..." },
  "proxy_id": 5,
  "concurrency": 3,
  "priority": 50,
  "group_ids": [3],
  "notes": null,
  "rate_multiplier": null,
  "load_factor": null
}
```
`model_mapping` rides inside `credentials.model_mapping` (identity map of the
group's enabled models). `notes` MUST be left empty (Hard Rule 6).

## Re-authorization of an existing account (replaces "重新授权" dialog)

From `ReAuthAccountModal.vue`:

1. `generate-auth-url { proxy_id }` → `auth_url` + `session_id`
2. (browser completes OpenAI OAuth; capture `code` + `state`)
3. `exchange-code` → `tokenInfo`
4. `buildCredentials(tokenInfo)` + `buildExtraInfo(tokenInfo)`
5. `POST /api/v1/admin/accounts/:id/apply-oauth-credentials`
   ```json
   { "type": "oauth", "credentials": {...}, "extra": {...} }
   ```

`apply-oauth-credentials` differs from the generic `PUT /:id`:
- accepts only `type` / `credentials` / `extra` (no concurrency/rpm/quota fields)
- `extra` is merged at the JSONB key level (never a full overwrite)
- clears the account error and invalidates the token cache server-side

This avoids Hard Rule 19's replace-not-merge footgun entirely: it does not touch
`model_mapping`, group bindings, or non-credential settings.

## Account verification / management endpoints

| Operation | Method + path | Notes |
|---|---|---|
| Read full account (identity, credentials_status, schedulable, error) | `GET /api/v1/admin/accounts/:id` | Use for the Hard Rule 16 identity + credential gate |
| List / search | `GET /api/v1/admin/accounts?search=<q>&platform=openai` | Dedup and reauth ID lookup |
| Test (SSE) | `POST /api/v1/admin/accounts/:id/test` | Must end in `test_complete success=true` |
| Set schedulable | `POST /api/v1/admin/accounts/:id/schedulable` body `{schedulable:true}` | Re-enable after reauth |
| Delete | `DELETE /api/v1/admin/accounts/:id` | For deactivated / mismatched accounts |
| Refresh token (refresh_token grant) | `POST /api/v1/admin/openai/accounts/:id/refresh` | Only when the refresh token is still valid |
| Update credentials (full replace) | `PUT /api/v1/admin/accounts/:id` | **Hard Rule 19**: replaces ALL non-token credential fields; GET first, send complete credentials |
| Clear error | `POST /api/v1/admin/accounts/:id/clear-error` | |
| Recover state | `POST /api/v1/admin/accounts/:id/recover-state` | DB-only rate-limit recovery |

> `POST /api/v1/admin/accounts/:id/models/sync-upstream` returns `400` for
> `oauth` accounts (apikey only). Do not use it.

## Helper

All of the above are wrapped by `skills/sub2api-auth/src/sub2api-admin-api.mjs`,
importable as functions or usable as a CLI. CLI output is redacted by default;
pass `--raw` for a process-local pipe. The API key is read from
`SUB2API_ADMIN_API_KEY` (`.env` or env) and never printed.

```
node src/sub2api-admin-api.mjs generate-auth-url [--proxy-id N]
node src/sub2api-admin-api.mjs create --name <email> --proxy-id N --group-ids 3 --concurrency 3 --session-id S --code C --state T
node src/sub2api-admin-api.mjs apply --id 12 --session-id S --code C --state T
node src/sub2api-admin-api.mjs verify --id 12
node src/sub2api-admin-api.mjs test --id 12
node src/sub2api-admin-api.mjs schedulable --id 12 --on true
node src/sub2api-admin-api.mjs list --search <email>
node src/sub2api-admin-api.mjs delete --id 12
```

## What still requires a browser (unchanged)

The OpenAI OAuth user flow itself runs on `auth.openai.com` and cannot be driven
by the sub2API admin API:
- email + password entry (Hard Rule 14: native setter)
- password form submission (Hard Rule 15: `requestSubmit`)
- MFA / authenticator / email OTP (Hard Rule 17)
- phone binding (SIM pool)
- consent (Hard Rule 16: identity gate)
- account-chooser / deactivated handling

The browser only needs to: open the API-generated `auth_url`, complete the
OpenAI flow, and surface the callback `code` + `state`. Everything before and
after that is now an API call.
