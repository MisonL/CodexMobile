export function createRelayMetrics() {
  return {
    relayRequestsTotal: 0,
    relayRequestsFailed: 0,
    relayRequestsTimedOut: 0,
    rateLimitedTotal: 0,
    pendingLimitRejectedTotal: 0,
    authValidationMissTotal: 0,
    macAuthFailuresTotal: 0,
    macConnectsTotal: 0,
    macDisconnectsTotal: 0,
    macHeartbeatMissesTotal: 0,
    multiMacRejectedTotal: 0,
    realtimeTunnelsTotal: 0,
    realtimeTunnelsClosedTotal: 0
  };
}

export function relayStateFrom({ authenticated, macConnected, macLocalReachable, macHeartbeatMissesTotal, relayRequestsTimedOut }) {
  if (!authenticated) {
    return 'pairing_required';
  }
  if (!macConnected) {
    return 'mac_offline';
  }
  if (macLocalReachable === false) {
    return 'mac_local_offline';
  }
  if (macHeartbeatMissesTotal > 0 || relayRequestsTimedOut > 0) {
    return 'degraded';
  }
  return 'ready';
}

export function buildRelayStatus({
  authenticated = false,
  browserSocketsCurrent,
  heartbeatMs,
  idleHeartbeatMs,
  macConnectionEpoch,
  macConnected,
  macInfo,
  metrics,
  pendingRelayRequests,
  pendingRequestsMax,
  browserPendingRequestsMax,
  requestBodyMaxBytes,
  previousRelaySecret,
  realtimeSocketsCurrent,
  relayStartedAt
}) {
  return {
    mode: 'relay',
    relayState: relayStateFrom({
      authenticated,
      macConnected,
      macLocalReachable: macInfo?.localStatus?.reachable,
      macHeartbeatMissesTotal: metrics.macHeartbeatMissesTotal,
      relayRequestsTimedOut: metrics.relayRequestsTimedOut
    }),
    connected: true,
    authenticated,
    requiresPairing: !authenticated,
    macConnected,
    macDeviceName: macInfo?.deviceName || '',
    macConnectionEpoch,
    macConnectedAt: macInfo?.connectedAt || '',
    macLastSeenAt: macInfo?.lastSeenAt || '',
    localStatus: macInfo?.localStatus || { reachable: false, checkedAt: '' },
    pendingRelayRequests,
    relayStartedAt,
    limits: {
      pendingRequestsMax,
      browserPendingRequestsMax,
      requestBodyMaxBytes,
      heartbeatMs,
      idleHeartbeatMs
    },
    secrets: {
      previousConfigured: Boolean(previousRelaySecret)
    },
    metrics: {
      ...metrics,
      browserSocketsCurrent,
      realtimeSocketsCurrent,
      pendingRequestsCurrent: pendingRelayRequests
    }
  };
}
