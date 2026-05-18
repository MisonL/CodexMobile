# CR-RELAY-REQUEST-STREAMING-2026-05-18

## 范围

本记录覆盖 relay request streaming 收口：Space 不再为 `/api/uploads` 和 `/api/voice/transcribe` 读取完整 multipart body，而是通过 WebSocket chunk 帧转发给 Mac connector，再由 connector 以 Web `ReadableStream` 转发到 Mac 本地 HTTP 服务。

## 变更摘要

- Space 新增 `http.request.start`、`http.request.chunk`、`http.request.end` 和 `http.request.error` 发送路径。
- Mac connector 新增 request stream 接收与本地 `fetch` streaming body 转发。
- `scripts/relay-smoke.mjs` 新增真实 connector fixture 覆盖：
  - `/api/uploads` multipart body 必须包含 `hello-upload`。
  - `/api/voice/transcribe` multipart body 必须包含 `voice-bytes`。
- 保留 `/ws/realtime` 和 `/generated/*` 的显式不支持边界。

## 验证记录

| Command | Exit | Result |
| --- | --- | --- |
| `node --check server/relay-protocol.js` | 0 | Passed. |
| `node --check server/relay-runtime.js` | 0 | Passed. |
| `node --check server/relay-http.js` | 0 | Passed. |
| `node --check scripts/relay-mac-client.mjs` | 0 | Passed. |
| `node --check scripts/relay-smoke.mjs` | 0 | Passed. |
| `npm run smoke:relay` | 0 | Passed; output included `Relay smoke ok`. |
| `npm run smoke` | 0 | Passed; output included `Smoke ok`. |
| `npm run build` | 0 | Passed. |
| `git diff --check` | 0 | Passed. |

## 结论

Request streaming for upload and voice transcription is verified locally through the real relay server, real Mac connector process, and local HTTP fixture. Response streaming for generated assets, speech audio, large responses, realtime voice, multi-Mac routing, and secret rotation remain outside this checkpoint.
