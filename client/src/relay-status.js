export const DEFAULT_STATUS = {
  connected: false,
  provider: 'cliproxyapi',
  model: 'gpt-5.5',
  modelShort: '5.5 中',
  reasoningEffort: 'xhigh',
  models: [{ value: 'gpt-5.5', label: 'gpt-5.5' }],
  docs: {
    provider: 'feishu',
    integration: 'lark-cli',
    label: '飞书文档',
    configured: false,
    connected: false,
    user: null,
    homeUrl: 'https://docs.feishu.cn/',
    cliInstalled: false,
    skillsInstalled: false,
    capabilities: [],
    codexEnabled: false,
    authorizationReady: false,
    missingScopes: [],
    scopeGroups: [],
    slidesAuthorized: false,
    sheetsAuthorized: false,
    authPending: null
  },
  voiceRealtime: { configured: false, model: 'qwen3.5-omni-plus-realtime', provider: '阿里百炼' },
  auth: { authenticated: false }
};

export const CONNECTION_STATUS = {
  connected: { label: '已连接', className: 'is-connected' },
  connecting: { label: '连接中', className: 'is-connecting' },
  pairing_required: { label: '需要配对', className: 'is-disconnected' },
  mac_offline: { label: 'Mac 未连接', className: 'is-disconnected' },
  mac_local_offline: { label: '本地服务离线', className: 'is-disconnected' },
  degraded: { label: '连接不稳定', className: 'is-connecting' },
  disconnected: { label: '已断开', className: 'is-disconnected' }
};

export function authenticatedFromStatus(data) {
  return Boolean(data?.authenticated ?? data?.auth?.authenticated);
}

export function connectionStateFromStatus(nextStatus) {
  if (nextStatus?.mode !== 'relay') {
    return nextStatus?.connected ? 'connected' : 'disconnected';
  }
  if (nextStatus.relayState && CONNECTION_STATUS[nextStatus.relayState]) {
    return nextStatus.relayState;
  }
  if (!authenticatedFromStatus(nextStatus) || nextStatus.requiresPairing) {
    return 'pairing_required';
  }
  if (!nextStatus.macConnected) {
    return 'mac_offline';
  }
  if (nextStatus.localStatus?.reachable === false) {
    return 'mac_local_offline';
  }
  return nextStatus.connected ? 'connected' : 'disconnected';
}

export function relayDisabledReason(connectionState) {
  if (connectionState === 'mac_offline') {
    return 'Mac 连接器未在线';
  }
  if (connectionState === 'mac_local_offline') {
    return 'Mac 本地服务未启动';
  }
  if (connectionState === 'pairing_required') {
    return '需要重新配对';
  }
  if (connectionState === 'disconnected') {
    return '连接已断开';
  }
  return '';
}
