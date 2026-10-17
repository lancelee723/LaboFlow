# IM Test-Account Mode (FR-IM-13)

Personal users can drive LaboFlow's IM channel (module 04) with **test-app
credentials** before an organization approves a production app. This is a
DEVELOPMENT facility: the in-product guidance (`AssistantChannelsPage` → the
Feishu card → "Using a Feishu TEST app") states the same limits summarized
here.

## What a test account is

| Provider | Test path | Notes |
| --- | --- | --- |
| Feishu | 测试企业 / dev-version custom app on open.feishu.cn | Same credential shape as production: `app_id` + `app_secret` (+ `verification_token` / `encrypt_key` for webhook mode) |
| WeCom | 未接入测试号 | Production app credentials only |
| WeChat MP | 沙箱（公众平台测试号） | Limited template/message APIs |

## Connection modes and public reachability

- **WSS long connection (Feishu, default)** — the desktop opens an outbound
  WebSocket to Feishu. **No public callback is required.** This is the
  recommended mode for test apps: credentials paste in, connect, done.
- **Webhook mode** — Feishu's cloud POSTs events to YOUR machine, so the local
  HTTP endpoint must be reachable from the internet:
  1. Expose the local port with a tunnel (ngrok / frp / cloudflared, any
     TCP/HTTP tunnel works; the port is configurable in the webhook card,
     default `3800`).
  2. Configure the request URL in the Feishu app console to the tunnel's
     public URL, and fill `verification_token` / `encrypt_key` from the same
     page into the channel card — the desktop verifies the handshake and
     decrypts encrypted pushes with them.
  3. Keep `lanOpen` off unless other machines on your LAN must call the
     desktop directly; the secret field stays mandatory either way.

## Development-use limits (stated in-product)

- Message API quotas on test apps are lower than production; a busy channel
  will rate-limit.
- Test apps cannot be distributed to other users; they are for personal
  debugging only and must not serve as a production channel.
- Available scopes (e.g. `im:message.*`) must be enabled on the test app the
  same way as production; missing scopes surface as the `permission`
  diagnostic in the channel card.

## Troubleshooting pointers

- Credential rejections map to the `credential` diagnostic (Feishu codes
  `10014` / `99991663`).
- Unpublished app / caller outside the availability scope maps to `publish`.
- Network failures (tunnel down) surface as the `network` diagnostic on send.
