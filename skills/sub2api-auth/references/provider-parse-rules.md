# Provider Document Parsing Rules

Rules derived from real provider delivery screenshots. Agent follows these when parsing user-provided screenshots or text.

## Source Modes and Precedence

- Treat user-pasted provider one-click-copy output as `direct_copy_text`. It is a first-class source; values copied directly as text do not require visual-model or OCR validation.
- Treat values read only from pixels as `screenshot`. Every critical screenshot-only value—including credentials, URLs, identifiers, provider/order metadata, stated quantity, and timestamp—requires two independent visual reads that agree.
- If identified direct one-click-copy output conflicts with screenshot OCR, prefer the direct value only when it passes the structural rules below. Record both source modes and the conflict resolution in the redacted preview without echoing either value.
- Use direct text for credential values and row identifiers. An accompanying order screenshot/page may supply only missing provider, order number, stated quantity, and order-creation timestamp, subject to the screenshot cross-validation rule for critical strings.
- Never infer missing metadata from a URL host, current date, paste/import time, another pack, a prior order, or an example in this reference. Show each absent field as `missing` and ask one compact follow-up. A missing order timestamp blocks `valid_until` and makes the affected SIM ineligible for write or authorization.

## Direct-Text Section Parsing and Normalization

1. Normalize line endings, then trim only surrounding whitespace and blank lines from the whole block and individual extracted fields. Do not alter internal characters or case in passwords, tokens, URLs, emails, or phone identifiers.
2. Do not HTML-decode direct clipboard text unless provenance proves that the input is escaped HTML source rather than rendered clipboard text.
3. Parse each `=== 使用说明 ===` / `=== 卡密内容 ===` pair independently. Do not carry metadata or values between pairs.
4. Extract account or SIM rows only from `卡密内容`; instruction examples are not data rows. Extract the shared password and platform URLs only from their labeled fields in `使用说明`.
5. For SIM rows, split once on the first `|`; when no `|` exists, split once on the first `----`. Preserve the entire right side, including its query/token string.

## Structural, Quantity, Type, and Duplicate Gates

- GPT row: require a complete valid email shape, a non-empty shared password, and a valid HTTP(S) MFA URL when present.
- SIM row: require a digits-only phone identifier and a non-empty HTTP(S) URL, with neither side empty.
- Reject malformed rows. Do not silently repair, normalize, decode, or guess credential characters.
- Always report the observed parsed-row count. When a stated quantity exists, require exact equality. When it is absent, mark the authoritative quantity check `unavailable`; the observed count is not a substitute.
- Before any create, detect duplicates within the incoming batch and against current Base records. Project only the minimum identifiers needed for the comparison; never read or print unneeded credential fields. Do not silently create duplicates and do not use batch-create until the duplicate result is resolved.
- Do not classify a platform as `网页` or `API` from URL shape. Require an observed live response. Until then use only a schema-supported unknown state; because GPT MFA currently has no documented `unknown` enum, absent live type evidence blocks that GPT write pending schema/evidence resolution.

## Dual Visual Model Cross-Validation

1. For every critical value extracted only from a screenshot, run two independent visual model reads.
2. If both reads produce identical strings, adopt the result.
3. If they differ, do not adopt either screenshot-derived value. Stop and request new evidence. A user response can resolve the value without two agreeing visual reads only when the user supplies identified direct one-click-copy text and that value passes the direct-text structural path; a plain confirmation of one visual candidate is insufficient.
4. After extraction, echo a structurally complete but redacted preview. If any metadata, quantity, structural, type-evidence, or duplicate blocker remains, request the missing evidence and do not ask for write confirmation. Only after every blocker is resolved may the preview ask for explicit confirmation for the current batch. Preserve counts, provider/order provenance, and one row per parsed item, but mask passwords, tokens, MFA material, full email addresses, full phone numbers, and secret-bearing URLs.

## HTML Entity Handling

- Screenshot OCR is pixel-derived text. Preserve it exactly for the two independent visual reads; do not reinterpret an OCR fragment such as `&#26;` as an HTML entity.
- Decode only when provenance proves the value came from HTML source/DOM text that still contains escaped entities.
- Use a standards-compliant decoder. Examples: `&amp;` → `&`, `&#35;` → `#`, `&#33;` → `!`; numeric entities map to their actual Unicode code points.
- `&#26;` does **not** mean `&`; it is Unicode control code U+001A. If a visual read produces it inside a password, treat it as suspicious OCR and require two agreeing visual reads. Alternatively, the user may supply identified direct one-click-copy text, which must follow the direct-text structural path; merely confirming one OCR candidate is insufficient.

For screenshots, cross-validate raw visual reads first. For proven HTML-source strings, decode after capture and then cross-validate the decoded value before storage.

## GPT Account Pack Format

Observed structure from a redacted real provider order snapshot; provider and order identifiers are withheld:

- **Card list**: Each card entry contains one email address. Cards are numbered (第1张, 第2张, ...).
- **Password**: Found in "使用说明" section, typically labeled "ChatGPT 登录密码默认：XXX" or "发货格式（Gmail 邮件发货，账户已添加密码和 MFA）（ChatGPT 登录密码默认：XXX）". This is a shared password for all accounts in the pack.
- **MFA platform URL**: Found in "使用说明" section, labeled "MFA 接码地址：URL". Preserve the validated HTTP(S) value in process memory and mask it in output.
- **Email helper URL**: Sometimes mentioned separately for email verification codes. Preserve a validated HTTP(S) value in process memory and mask it in output.
- **Order number**: From "订单号" field. Preserve it in process memory and mask it in output.
- **Provider name**: From the page header or merchant name. Preserve it in process memory and mask it in output.
- **Quantity**: From "数量" field. Must match the number of card entries parsed.

Parsing algorithm:
1. Extract complete email rows only from the `卡密内容` section.
2. Extract the non-empty shared password only from its labeled usage-instruction field.
3. Extract and validate the labeled HTTP(S) MFA platform URL.
4. Extract and validate a labeled email helper URL if present.
5. Capture order number, provider, stated quantity, and order-creation timestamp from the pack or its accompanying order evidence; otherwise mark each missing value explicitly.
6. Report the observed email count. If stated quantity exists, require equality; otherwise mark the authoritative check unavailable.

## SIM Card Pack Format

Observed structure from a redacted real provider order snapshot; provider and order identifiers are withheld:

- **Card list**: Each card entry contains `phone_number|sms_url` or `phone_number----sms_url`. Both `|` and `----` separators must be recognized.
- **Phone number**: Digits only and may include a country-code prefix. Preserve the complete value only in process memory and mask it in output.
- **SMS URL**: Full HTTP(S) URL including its complete query/token string. Preserve it only in process memory and mask it in output.
- **Order number**: From "订单号" field.
- **Validity**: From usage instructions, typically "有效期25-30天". Parse the upper bound (30 days) as default valid_until offset from order creation date.
- **Quantity**: From "数量" field. Must match number of card entries parsed.

Parsing algorithm:
1. For each row in `卡密内容`, split once on the first `|`; if none exists, split once on the first `----`.
2. Validate the left side as a non-empty digits-only phone identifier and the entire right side as a non-empty HTTP(S) URL.
3. Extract the order number, order-creation timestamp, stated validity range, and stated quantity. Missing order timestamp blocks `valid_until`; never substitute paste/import time.
4. Compute `valid_until` only from the verified order-creation timestamp plus the stated upper-bound duration.
5. Report the observed entry count. If stated quantity exists, require equality; otherwise mark the authoritative check unavailable.

## Multi-Pack Handling

User may provide multiple direct-copy blocks and/or screenshots in one message. Parse each pack independently. Merge valid records only after every pack has retained its own provenance and passed metadata, quantity, structural, type-evidence, and duplicate gates; never assume two packs share an order or provider.

## Echo Format

After parsing, always present a structurally complete redacted preview. Include source mode (`direct_copy_text` and/or screenshot metadata), observed count, one masked row per item, missing fields, structural/quantity/type validation, and duplicate-check state. The unmasked values remain only in the current in-memory operation and the confirmed Feishu Base write; do not print them or persist them to local JSON/temp files.

```
GPT 账号包（source: <direct_copy_text|screenshot|direct_copy_text + screenshot metadata, exactly as used>）:
  订单: <masked-or-missing>; provider: <masked-or-missing>; stated quantity: <value-or-missing>
  observed count: 2; validation: <state>; duplicate check: <state>
  密码: ***
  MFA 平台: <non-secret origin-or-***>; type evidence: <state>
  邮箱助手: <non-secret origin-or-***-or-absent>
  账号列表:
    1. e***@***
    2. a***@***

手机卡包（source: <direct_copy_text|screenshot|direct_copy_text + screenshot metadata, exactly as used>）:
  订单: <masked-or-missing>; order timestamp: <masked-or-missing>; stated quantity: <value-or-missing>
  observed count: 2; valid_until: <masked-or-unavailable>
  validation: <state>; duplicate check: <state>; type evidence: <state>
  1. 12****78 → <non-secret origin-or-***>
  2. 98****54 → <non-secret origin-or-***>

missing fields/blockers: <none-or-list>
<If blockers exist, ask one compact evidence follow-up. Otherwise ask for explicit confirmation for this batch.>
```

Never use an earlier general automation request as confirmation. Only explicit confirmation for the current parsed batch, issued after all blockers are resolved, permits its Base write or authorization start.
