# WeChat Official Account draft API reference

Verified against the official documentation on 2026-08-16.

## Endpoints

| Operation | Method and path | Purpose |
| --- | --- | --- |
| Access token | `GET /cgi-bin/token` | Exchange AppID and AppSecret for an access token |
| Draft count | `GET /cgi-bin/draft/count` | Read-only permission probe |
| Permanent cover | `POST /cgi-bin/material/add_material?type=image` | Upload the cover and receive a permanent `media_id` |
| Body image | `POST /cgi-bin/media/uploadimg` | Upload an article image and receive a WeChat-hosted URL |
| Create draft | `POST /cgi-bin/draft/add` | Create one draft |
| Get draft | `POST /cgi-bin/draft/get` | Read the created draft back |

API base: `https://api.weixin.qq.com`.

## Current limits used by the script

- Title: at most 32 Unicode characters.
- Author: at most 16 Unicode characters.
- Digest: at most 120 Unicode characters.
- Source URL: at most 1 KiB.
- Article HTML: fewer than 20,000 characters and smaller than 1 MiB.
- A normal news draft requires a permanent cover `thumb_media_id`.
- Body images must use URLs returned by `media/uploadimg`; external image URLs are filtered.
- `media/uploadimg` accepts JPG/PNG images smaller than 1 MiB.
- This skill narrows cover input to JPG/PNG, with a maximum of 10 MiB.

## Common errors

| Code | Meaning | Response |
| --- | --- | --- |
| `40001`, `40014`, `42001` | Invalid or expired token | Obtain one fresh token and retry the failed request once |
| `40007` | Invalid media ID | Recheck that the cover upload returned a permanent media ID |
| `40009` | Invalid image size | Resize or recompress the image before retrying |
| `40125` | Invalid AppSecret | Correct the local secret; never print it |
| `40164` | Caller IP is not in the whitelist | Add the current stable egress IP in the WeChat admin console |

## Official sources

- [Access token](https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken)
- [Draft management](https://developers.weixin.qq.com/doc/service/guide/product/draft.html)
- [Create draft](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add)
- [Get draft](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_getdraft)
- [Material management](https://developers.weixin.qq.com/doc/service/guide/product/asset.html)
- [Upload article image](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_uploadimage)
- [Upload permanent material](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_addmaterial)
