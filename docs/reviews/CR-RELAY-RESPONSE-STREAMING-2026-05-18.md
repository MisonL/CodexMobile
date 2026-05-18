# CR-RELAY-RESPONSE-STREAMING-2026-05-18

## 范围

本记录覆盖 `/generated/*` response streaming 收口：Space 不再对已认证 generated asset 返回 `501 relay_streaming_required`，而是通过 Mac connector 从本地服务读取响应 body，并用 `http.response.start`、`http.response.chunk`、`http.response.end` 分帧回传给浏览器。

## 变更摘要

- Space relay 新增 `http.stream.request` 请求路径。
- Mac connector 新增 streaming response 回传路径。
- Space relay 对 response chunk 做 sequence 与 byte length 校验，并在写浏览器响应时处理 backpressure。
- `scripts/relay-smoke.mjs` 新增真实 connector fixture 覆盖：
  - 未认证 `/generated/test.png` 仍返回 `401`。
  - 已认证 `/generated/test.png` 返回超过 2 MB 的 `image/png` 字节，证明没有走小响应缓冲路径。

## 验证记录

| Command | Exit | Result |
| --- | --- | --- |
| `node --check server/relay-runtime.js` | 0 | Passed. |
| `node --check server/relay-http.js` | 0 | Passed. |
| `node --check scripts/relay-mac-client.mjs` | 0 | Passed. |
| `node --check scripts/relay-smoke.mjs` | 0 | Passed. |
| `npm run smoke:relay` | 0 | Passed; output included `Relay smoke ok`. |

## 结论

Generated asset response streaming is verified locally through the real relay server, real Mac connector process, and local HTTP fixture. Remaining Phase 2 and Phase 3 work still includes `/api/voice/speech` audio streaming, realtime voice, multi-Mac routing, secret rotation, real Space redeploy, and final PR/git收口.
