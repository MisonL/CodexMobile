# CR-RELAY-SPEECH-STREAMING-2026-05-18

## 范围

本记录覆盖 `/api/voice/speech` speech audio response streaming 收口：浏览器仍发送小 JSON 请求体，Space relay 通过 `http.stream.request` 转发给 Mac connector，connector 从 Mac 本地服务读取音频响应并用 `http.response.start`、`http.response.chunk`、`http.response.end` 分帧回传。

## 变更摘要

- `http.stream.request` 支持携带小型请求体，覆盖 `POST /api/voice/speech` 的 `{ "text": "..." }`。
- `/api/voice/speech` 改走 response streaming，避免 Mac connector 把大音频缓冲成单个 base64 JSON response。
- `scripts/relay-smoke.mjs` 新增真实 connector fixture 覆盖：
  - 本地 fixture 必须收到 `text = "fixture speech"`。
  - relay 返回超过 2 MB 的 `audio/mpeg` 字节，证明没有走小响应缓冲路径。

## 验证记录

| Command | Exit | Result |
| --- | --- | --- |
| `node --check server/relay-protocol.js` | 0 | Passed. |
| `node --check server/relay-http.js` | 0 | Passed. |
| `node --check scripts/relay-mac-client.mjs` | 0 | Passed. |
| `node --check scripts/relay-smoke.mjs` | 0 | Passed. |
| `npm run smoke:relay` | 0 | Passed; output included `Relay smoke ok`. |

## 结论

Speech audio response streaming is verified locally through the real relay server, real Mac connector process, and local HTTP fixture. Remaining full-goal work still includes realtime voice, multi-Mac routing, secret rotation, real Space redeploy, frontend runtime review, and final PR/git收口.
