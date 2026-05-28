import { useEffect, useRef } from 'react';
import { apiFetch, getToken, websocketUrl } from '../api.js';
import { mergeServerMessagesWithLocalState } from '../app-message-state.js';
import { canUseAppShellFromStatus, connectionStateFromStatus } from '../relay-status.js';
import { handleSocketMessage } from './app-websocket-events.js';

const WS_RECONNECT_INITIAL_MS = 1200;
const WS_RECONNECT_MAX_MS = 30000;
const WS_RECONNECT_BACKOFF = 1.6;
const WS_RECONNECT_JITTER_RATIO = 0.2;
const WS_STATUS_FALLBACK_MS = 3000;
const WS_RECONNECT_STABLE_MS = 5000;

function reconnectDelayWithJitter(delayMs) {
  const offsetRatio = (Math.random() * 2 - 1) * WS_RECONNECT_JITTER_RATIO;
  return Math.max(1, Math.round(delayMs * (1 + offsetRatio)));
}

export function useAppWebSocket(app, runRegistry, turnRefresh) {
  const runtimeRef = useRef({ app, runRegistry, turnRefresh });
  runtimeRef.current = { app, runRegistry, turnRefresh };

  useEffect(() => {
    if (!app.authenticated || !getToken()) {
      app.setConnectionState('disconnected');
      return undefined;
    }

    let stopped = false;
    let reconnectTimer = null;
    let reconnectStableTimer = null;
    let statusFallbackTimer = null;
    let reconnectDelayMs = WS_RECONNECT_INITIAL_MS;
    let hasOpened = false;

    const refreshStatus = () => {
      return apiFetch('/api/status')
        .then((status) => {
          if (stopped) {
            return null;
          }
          const runtime = runtimeRef.current;
          runtime.app.setStatus(status);
          runtime.app.setAuthenticated(canUseAppShellFromStatus(status));
          runtime.app.setConnectionState(connectionStateFromStatus(status));
          runtime.runRegistry.syncActiveRunsFromStatus(status);
          return status;
        })
        .catch((error) => {
          console.warn('[websocket] status refresh failed:', error.message || error);
          return null;
        });
    };

    const refreshSelectedSessionMessages = (statusSnapshot) => {
      const runtime = runtimeRef.current;
      const session = runtime.app.selectedSessionRef.current;
      if (!session?.id || session.draft) {
        return;
      }
      const activeRuns = Array.isArray(statusSnapshot?.activeRuns) ? statusSnapshot.activeRuns : [];
      const preserveLocalRuns = Boolean(
        runtime.app.activePollsRef.current.size ||
        runtime.app.turnRefreshTimersRef.current.size
      );
      const sessionId = session.id;
      apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/messages?limit=120`)
        .then((data) => {
          const latest = runtimeRef.current;
          if (stopped || latest.app.selectedSessionRef.current?.id !== sessionId) {
            return;
          }
          latest.app.setMessages((current) =>
            mergeServerMessagesWithLocalState(current, data.messages || [], { activeRuns, preserveLocalRuns })
          );
        })
        .catch((error) => {
          console.warn(`[websocket] message refresh failed session=${sessionId}:`, error.message || error);
        });
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) {
        return;
      }
      const timeoutMs = reconnectDelayWithJitter(reconnectDelayMs);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, timeoutMs);
      reconnectDelayMs = Math.min(
        WS_RECONNECT_MAX_MS,
        Math.ceil(reconnectDelayMs * WS_RECONNECT_BACKOFF)
      );
    };

    const clearStatusFallbackTimer = () => {
      if (!statusFallbackTimer) {
        return;
      }
      window.clearTimeout(statusFallbackTimer);
      statusFallbackTimer = null;
    };

    const clearReconnectStableTimer = () => {
      if (!reconnectStableTimer) {
        return;
      }
      window.clearTimeout(reconnectStableTimer);
      reconnectStableTimer = null;
    };

    const markReconnectStable = (ws) => {
      if (stopped || runtimeRef.current.app.wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      reconnectDelayMs = WS_RECONNECT_INITIAL_MS;
      clearReconnectStableTimer();
    };

    const scheduleReconnectDelayReset = (ws) => {
      clearReconnectStableTimer();
      reconnectStableTimer = window.setTimeout(() => {
        markReconnectStable(ws);
      }, WS_RECONNECT_STABLE_MS);
    };

    const connect = () => {
      runtimeRef.current.app.setConnectionState('connecting');
      const ws = new WebSocket(websocketUrl());
      runtimeRef.current.app.wsRef.current = ws;

      ws.onopen = () => {
        if (stopped) {
          return;
        }
        const reconnecting = hasOpened;
        hasOpened = true;
        scheduleReconnectDelayReset(ws);
        runtimeRef.current.app.setConnectionState('connecting');
        const statusPromise = refreshStatus();
        clearStatusFallbackTimer();
        if (reconnecting) {
          statusPromise.then((status) => {
            if (status) {
              refreshSelectedSessionMessages(status);
            }
          });
        }
        statusFallbackTimer = window.setTimeout(() => {
          if (stopped) {
            clearStatusFallbackTimer();
            return;
          }
          refreshStatus();
          clearStatusFallbackTimer();
        }, WS_STATUS_FALLBACK_MS);
      };
      ws.onclose = () => {
        clearStatusFallbackTimer();
        if (stopped) {
          return;
        }
        clearReconnectStableTimer();
        runtimeRef.current.app.setConnectionState('disconnected');
        refreshStatus();
        scheduleReconnect();
      };
      ws.onerror = () => {
        if (stopped) {
          return;
        }
        runtimeRef.current.app.setConnectionState('disconnected');
      };
      ws.onmessage = (event) => {
        if (stopped) {
          return;
        }
        clearStatusFallbackTimer();
        handleSocketMessage({ ...runtimeRef.current, event });
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      clearReconnectStableTimer();
      clearStatusFallbackTimer();
      runtimeRef.current.app.wsRef.current?.close();
      runtimeRef.current.app.setConnectionState('disconnected');
    };
  }, [app.authenticated]);
}
