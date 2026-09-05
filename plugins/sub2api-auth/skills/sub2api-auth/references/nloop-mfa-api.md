# 2fa.nloop.cc MFA lookup API

evidence:
- `evidence_status`: `live_verified`
- `source_system`: `https://2fa.nloop.cc` (public ChatGPT MFA email-code query service; docs at `/api/docs`, OpenAPI 3.1 at `/api/openapi`)
- `captured_at`: `2026-08-12T11:05:24Z`
- `endpoint_method`: `GET /api/mfa/lookup?email=<email>`
- `provenance`: keyless public JSON API; live queries for all four OpenCodex reauth targets returned `found:true` with fresh 6-digit TOTPs (`service=ChatGPT`, `period=30`); `scripts/flow-mfa.mjs` switched to this API the same day after the platform's browser-UI query returned 0 rows for the same accounts
- `redaction_notes`: account emails, TOTP code values, and record `note` values are omitted; codes rotate every 30 s
- `source_sha256`: `35094a490b7f7296189cae5f9ef18866afb890315c84ad2bdf69424be7c9514f` (raw successful single-lookup response)

## Endpoints

| Route | Purpose |
|---|---|
| `GET/POST /api/mfa/lookup` | Single email. 200 `{ok:true, email, found, results:[MfaCode]}`; `found:false` = no platform record. 400 `INVALID_EMAIL`/`INVALID_PAYLOAD` |
| `POST /api/mfa/batch-lookup` | Up to 100 emails per call; one shared generation timestamp; invalid emails listed in `invalidEmails` without failing the batch |
| `GET /api/mfa/codes` | Batch code values (up to 1000 emails via repeated `email` params or `emails` list); `values` maps email → current code; recommended for business systems |

`MfaCode` fields: `service`, `email`, `note`, `code` (`^\d{6,8}$`), `remaining` (seconds left), `period` (30). No API key. Responses must not be cached. Storage failures return 500 and are retryable.

## Automation rules

- Prefer this API over the platform's browser UI for every email-keyed MFA fetch; the UI query can return 0 rows even when the API has a live record (observed 2026-08-12 on all four OpenCodex reauth targets).
- `found:false` means the platform holds no MFA record for that identity. Do not retry the UI. Follow Hard Rule 17: scan Base `notes` for an embedded `mfa_secret`, sync it to the field and run `flow-totp-local.mjs`; otherwise fall back to email OTP only after OpenAI offers it.
- When `remaining < 5`, wait for the next period and re-query once before filling (a near-expired code can be rejected).
- Multiple `results` rows for one email are ambiguous — stop rather than guess.
- The code is a secret: keep it process-local, embed via `JSON.stringify` into the piped browser script (Hard Rule 22), never print it (Hard Rule 4).
