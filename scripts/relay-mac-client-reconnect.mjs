import { DEFAULT_RELAY_IDLE_HEARTBEAT_MS } from '../server/relay-protocol.js';

export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const ACTIVE_RECONNECT_CAP_MS = 30000;
export const STABLE_RECONNECT_RESET_MS = 60000;

export function nextReconnectDelay(currentDelayMs, { active = false, idleHeartbeatMs = DEFAULT_RELAY_IDLE_HEARTBEAT_MS } = {}) {
  const capMs = active ? ACTIVE_RECONNECT_CAP_MS : idleHeartbeatMs;
  const delayMs = Math.min(Math.max(Number(currentDelayMs) || INITIAL_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS), capMs);
  return {
    delayMs,
    nextDelayMs: Math.min(delayMs * 2, capMs)
  };
}

export function shouldResetReconnectDelay(onlineForMs) {
  return Number(onlineForMs) >= STABLE_RECONNECT_RESET_MS;
}
