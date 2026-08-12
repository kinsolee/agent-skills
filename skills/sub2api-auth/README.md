# Sub2API and OpenCodex OpenAI OAuth helper

This skill manages OpenAI OAuth accounts for Sub2API and OpenCodex. It uses management APIs for account operations, ego-browser for the OpenAI login flow, and Feishu Base as the credential source of truth.

## Compatibility

The account-management workflow currently supports only Sub2API and OpenCodex. Configure each deployment through gitignored local environment files; keep real hostnames, LAN addresses, account identities, and credentials out of committed documentation.

It will:

- inspect Sub2API and OpenCodex account health through their management APIs
- try silent refresh before interactive Sub2API reauthorization
- drive isolated OpenAI email, password, MFA, optional phone, and consent steps
- submit callbacks without exposing the callback URL in argv or stdout
- verify persisted credentials and run a real post-authorization data-plane check

## Prerequisites

- Node.js 18 or newer
- ego-browser (ego-lite)
- authenticated `lark-cli` access to the `sub2api-auth` Base
- gitignored local environment files for the selected platform

## Setup

```bash
npm install
cp .env.example .env
```

Read [SKILL.md](SKILL.md) before running a live account flow. It contains the source-specific safety rules, exact verification gates, and the canonical script inventory.

## Common probes

Sub2API monitoring:

```bash
node ../../src/sub2api-reauth-runner.mjs --monitor-only
```

OpenCodex provider inventory:

```bash
node scripts/opencodex-providers.mjs
```

OpenCodex account patrol:

```bash
node scripts/opencodex-account.mjs check --refresh
```

Do not infer deactivation from a failed refresh. Only the explicit OpenAI `account_deactivated` page is terminal. Follow the full skill workflow for reauthorization, cleanup, and readback.
