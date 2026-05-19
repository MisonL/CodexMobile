import { once } from 'node:events';
import WebSocket from 'ws';
import {
  baseUrl,
  fail,
  multipartBody,
  request,
  requestBuffer,
  spawnConnector,
  waitForMacConnected
} from './relay-smoke-env.mjs';
import {
  generatedFixtureBytes,
  speechFixtureBytes,
  startLocalCodexFixture
} from './relay-smoke-fixture.mjs';
import { nextBrowserEvent } from './relay-smoke-support.mjs';

export async function verifyRealConnectorForwardsLocalWsEvents() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws?token=valid-token`);
    await once(ws, 'open');
    const eventPromise = nextBrowserEvent(ws, 'status-update', 5000);
    const result = await request('/api/chat/send', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: { projectId: 'fixture-project', message: 'hello' }
    });
    if (result.response.status !== 202 || result.data.turnId !== 'fixture-turn') {
      fail('real connector should forward chat request to local fixture', result);
    }
    const event = await eventPromise;
    ws.close();
    if (event.status !== 'running' || event.turnId !== 'fixture-turn') {
      fail('real connector should forward local ws status-update event', event);
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}

export async function verifyRealConnectorTunnelsRealtimeVoice() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws/realtime?token=valid-token`);
    await once(ws, 'open');
    const ready = await nextBrowserEvent(ws, 'voice.realtime.ready', 5000);
    if (ready.fixture !== true) {
      fail('realtime relay should forward local ready event', ready);
    }
    const pongPromise = nextBrowserEvent(ws, 'voice.test.pong', 5000);
    ws.send(JSON.stringify({ type: 'voice.test.ping', text: 'hello-realtime' }));
    const pong = await pongPromise;
    const binaryPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for realtime binary echo')), 5000);
      ws.once('message', (raw, isBinary) => {
        clearTimeout(timer);
        if (!isBinary) {
          reject(new Error('realtime binary echo should stay binary'));
          return;
        }
        resolve(Buffer.from(raw));
      });
    });
    ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });
    const binaryEcho = await binaryPromise;
    ws.close();
    if (pong.text !== 'hello-realtime') {
      fail('realtime relay should forward browser frames to local realtime websocket', pong);
    }
    if (!binaryEcho.equals(Buffer.from([1, 2, 3, 4]))) {
      fail('realtime relay should preserve binary websocket frames', binaryEcho);
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}

export async function verifyRealConnectorStreamsMultipartRequests() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const uploadBoundary = '----codexmobile-upload-boundary';
    let result = await request('/api/uploads', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': `multipart/form-data; boundary=${uploadBoundary}`
      },
      body: multipartBody(uploadBoundary, 'file', 'hello.txt', 'text/plain', 'hello-upload')
    });
    if (result.response.status !== 201 || result.data.kind !== 'upload' || !result.data.contentType.includes(uploadBoundary)) {
      fail('real connector should stream multipart upload to local fixture', result);
    }

    const voiceBoundary = '----codexmobile-voice-boundary';
    result = await request('/api/voice/transcribe', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': `multipart/form-data; boundary=${voiceBoundary}`
      },
      body: multipartBody(voiceBoundary, 'audio', 'voice.wav', 'audio/wav', 'voice-bytes')
    });
    if (result.response.status !== 200 || result.data.text !== 'fixture transcript' || !result.data.contentType.includes(voiceBoundary)) {
      fail('real connector should stream multipart voice transcription to local fixture', result);
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}

export async function verifyRealConnectorStreamsGeneratedAssets() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const result = await requestBuffer('/generated/test.png', {
      headers: { authorization: 'Bearer valid-token' }
    });
    if (
      result.response.status !== 200 ||
      result.response.headers.get('content-type') !== 'image/png' ||
      !result.body.equals(generatedFixtureBytes)
    ) {
      fail('real connector should stream generated asset bytes to browser', {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        bytes: result.body.length
      });
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}

export async function verifyRealConnectorStreamsSpeechAudio() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const result = await requestBuffer('/api/voice/speech', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text: 'fixture speech' })
    });
    if (
      result.response.status !== 200 ||
      result.response.headers.get('content-type') !== 'audio/mpeg' ||
      !result.body.equals(speechFixtureBytes)
    ) {
      fail('real connector should stream speech audio bytes to browser', {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        bytes: result.body.length
      });
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}
