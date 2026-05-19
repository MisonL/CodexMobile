import {
  connectMac
} from './relay-smoke-support.mjs';
import {
  fail,
  relayUrl,
  secret,
  spawnRelay,
  waitForRelay
} from './relay-smoke-env.mjs';
import { runBasicRelayAssertions } from './relay-smoke-basic.mjs';
import {
  verifyBrowserPendingLimit,
  verifyCachedTokenBypassesValidationRateLimit,
  verifyForwardedHttp,
  verifyGlobalPendingLimit,
  verifyMacOfflineState,
  verifyPerTokenRequestCap,
  verifyRelaySecretRotationGraceWindow,
  verifyRelayStartup
} from './relay-smoke-relay-scenarios.mjs';
import {
  verifyBrowserEvents,
  verifyDifferentMacDoesNotReplaceActiveMac,
  verifyIdleAndActiveHeartbeat,
  verifyReconnectAndUnsupportedRoutes
} from './relay-smoke-mac-scenarios.mjs';
import {
  verifyRealConnectorForwardsLocalWsEvents,
  verifyRealConnectorStreamsGeneratedAssets,
  verifyRealConnectorStreamsMultipartRequests,
  verifyRealConnectorStreamsSpeechAudio,
  verifyRealConnectorTunnelsRealtimeVoice
} from './relay-smoke-connector-scenarios.mjs';

async function main() {
  runBasicRelayAssertions();
  const relay = spawnRelay();
  try {
    await waitForRelay(relay);
    await verifyRelayStartup();
    await verifyRelaySecretRotationGraceWindow();
    await verifyMacOfflineState();
    const mac = await connectMac({ relayUrl, secret, reachable: true });
    await verifyDifferentMacDoesNotReplaceActiveMac(mac);
    await verifyIdleAndActiveHeartbeat(mac);
    const pendingLimitMac = await verifyBrowserPendingLimit(
      await verifyCachedTokenBypassesValidationRateLimit(
        await verifyPerTokenRequestCap(
          await verifyForwardedHttp(mac)
        )
      )
    );
    const globalLimitMac = await verifyGlobalPendingLimit(pendingLimitMac);
    globalLimitMac.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const eventMac = await connectMac({ relayUrl, secret, reachable: true });
    await verifyBrowserEvents(eventMac);
    eventMac.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await verifyReconnectAndUnsupportedRoutes();
    await verifyRealConnectorForwardsLocalWsEvents();
    await verifyRealConnectorTunnelsRealtimeVoice();
    await verifyRealConnectorStreamsMultipartRequests();
    await verifyRealConnectorStreamsGeneratedAssets();
    await verifyRealConnectorStreamsSpeechAudio();
    console.log('Relay smoke ok');
  } finally {
    relay.kill('SIGTERM');
  }
}

main().catch((error) => fail(error.message, error.stack));
