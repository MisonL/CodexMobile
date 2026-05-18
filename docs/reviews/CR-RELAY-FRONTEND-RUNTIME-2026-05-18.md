# CR-RELAY-FRONTEND-RUNTIME-2026-05-18

## 范围

本记录覆盖 relay browser fixture 的前端运行态复查，验证 Space relay UI 在 ready、发送和 Mac connector 断开场景下的可见状态与禁用态。

## 环境

- Fixture command: `PORT=9792 npm run smoke:relay:browser-fixture`
- Browser URL: `http://127.0.0.1:9792`
- Browser token: `valid-token`
- Mac fixture: `scripts/relay-browser-fixture.mjs` fake Mac connector

## 验证记录

| Check | Evidence | Result |
| --- | --- | --- |
| Ready state | 顶栏显示 `已连接`，项目显示 `Mac Project`，输入框、语音入口可见。截图：`/tmp/codexmobile-relay-ux-ready.png`。 | Passed |
| Chat send | 输入 `relay browser fixture test` 后点击发送，线程数从 `0` 变为 `1`，消息出现在当前会话，状态显示 `正在思考中`。 | Passed |
| Mac disconnect | 对 fixture 进程发送 `SIGUSR2` 后，页面显示 `Mac 未连接`。 | Passed |
| Disabled controls | Mac 断开后，文本框显示 `Mac 连接器未在线` 且 disabled，添加、语音对话、语音输入和发送按钮均 disabled。截图：`/tmp/codexmobile-relay-ux-offline.png`。 | Passed |

## 结论

Relay frontend runtime behavior matches the current UX contract for ready and Mac-offline states. This is local fixture browser evidence only; real Space frontend runtime still needs redeploy后的复验。
