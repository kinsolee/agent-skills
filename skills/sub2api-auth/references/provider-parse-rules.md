# Provider Document Parsing Rules

Rules derived from real provider delivery screenshots. Agent follows these when parsing user-provided screenshots or text.

## Dual Visual Model Cross-Validation

1. For every password, secret key, URL, or token string extracted from a screenshot, run two independent visual model reads.
2. If both reads produce identical strings, adopt the result.
3. If they differ, stop and ask the user to confirm the correct value. Do not guess or pick one.
4. After extraction, echo a structurally complete but redacted preview to the user and wait for explicit confirmation before writing to Feishu Base. Preserve counts, provider/order provenance, and one row per parsed item, but mask passwords, tokens, MFA material, full email addresses, full phone numbers, and secret-bearing URLs.

## HTML Entity Handling

- Screenshot OCR is pixel-derived text. Preserve it exactly for the two independent visual reads; do not reinterpret an OCR fragment such as `&#26;` as an HTML entity.
- Decode only when provenance proves the value came from HTML source/DOM text that still contains escaped entities.
- Use a standards-compliant decoder. Examples: `&amp;` → `&`, `&#35;` → `#`, `&#33;` → `!`; numeric entities map to their actual Unicode code points.
- `&#26;` does **not** mean `&`; it is Unicode control code U+001A. If a visual read produces it inside a password, treat it as suspicious OCR and rely on the independent visual comparison or user confirmation.

For screenshots, cross-validate raw visual reads first. For proven HTML-source strings, decode after capture and then cross-validate the decoded value before storage.

## GPT Account Pack Format

Observed structure (from 链动小铺 order LD26072731CVWM):

- **Card list**: Each card entry contains one email address. Cards are numbered (第1张, 第2张, ...).
- **Password**: Found in "使用说明" section, typically labeled "ChatGPT 登录密码默认：XXX" or "发货格式（Gmail 邮件发货，账户已添加密码和 MFA）（ChatGPT 登录密码默认：XXX）". This is a shared password for all accounts in the pack.
- **MFA platform URL**: Found in "使用说明" section, labeled "MFA 接码地址：URL". Example: `https://2fa.nloop.cc/`
- **Email helper URL**: Sometimes mentioned separately for email verification codes. Example: `https://email.nloop.cc/`
- **Order number**: From "订单号" field. Example: `LD26072731CVWM`
- **Provider name**: From page header or merchant name. Example: "链动小铺"
- **Quantity**: From "数量" field. Must match the number of card entries parsed.

Parsing algorithm:
1. Extract all email addresses from the card list section (look for numbered entries or lines matching email regex).
2. Extract the shared password from the usage instructions.
3. Extract MFA platform URL.
4. Extract email helper URL if present.
5. Extract order number and provider name.
6. Verify: number of emails parsed == quantity stated in order.

## SIM Card Pack Format

Observed structure (from 链动小铺 order LD260727B55K8S):

- **Card list**: Each card entry contains `phone_number|sms_url` or `phone_number----sms_url`. Both `|` and `----` separators must be recognized.
- **Phone number**: Digits only, may include country code prefix. Example: `13103887887`
- **SMS URL**: Full URL including token parameter. Example: `https://sms369.vip/api/sms/access?token=xxx`
- **Order number**: From "订单号" field.
- **Validity**: From usage instructions, typically "有效期25-30天". Parse the upper bound (30 days) as default valid_until offset from order creation date.
- **Quantity**: From "数量" field. Must match number of card entries parsed.

Parsing algorithm:
1. For each card entry, split on `|` first; if no `|` found, split on `----`.
2. Left part = phone_number, right part = sms_url.
3. Extract order number and validity period.
4. Verify: number of entries parsed == quantity stated.

## Multi-Pack Handling

User may provide multiple screenshots in one message (e.g., one GPT pack + one SIM pack, or multiple of each). Parse each independently, then merge all gpt_accounts records and all sim_cards records into single batch writes.

## Echo Format

After parsing, present a redacted preview to the user in this format. The unmasked values remain only in the current in-memory operation and the confirmed Feishu Base write; do not print them or persist them to local JSON/temp files.

```
GPT 账号包（订单 XXXXX，provider: XXX）:
  密码: ***
  MFA 平台: https://2fa.example/（不含密钥时可显示域名；secret-bearing URL 用 ***）
  邮箱助手: https://email.example/（如有，不含密钥时可显示域名）
  账号列表:
    1. e***1@example.com
    2. e***2@example.com
    ...

手机卡包（订单 XXXXX）:
  1. 131****7887 → https://sms369.vip/...token=***
  2. 131****6503 → https://sms369.vip/...token=***
  ...

确认写入飞书 Base？
```
