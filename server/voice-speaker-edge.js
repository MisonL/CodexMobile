import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  EDGE_GEC_VERSION,
  EDGE_SPEECH_FORMAT,
  EDGE_SPEECH_MIME_TYPE,
  EDGE_SPEECH_PROVIDER,
  EDGE_SPEECH_TIMEOUT_MS,
  EDGE_TRUSTED_CLIENT_TOKEN,
  edgeSpeechVoice
} from './voice-speaker-config.js';

export function edgeConnectionId() {
  return randomUUID().replace(/-/g, '');
}

export function edgeMuid() {
  return randomBytes(16).toString('hex').toUpperCase();
}

export function edgeSecMsGec() {
  const windowsEpochSeconds = 11644473600n;
  let seconds = BigInt(Math.floor(Date.now() / 1000)) + windowsEpochSeconds;
  seconds -= seconds % 300n;
  const ticks = seconds * 10000000n;
  return createHash('sha256')
    .update(`${ticks}${EDGE_TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

export function escapeSsml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function edgeProsodyAttribute(name, fallback) {
  const value = process.env[`CODEXMOBILE_SPEECH_EDGE_${name}`] ||
    process.env[`CODEXMOBILE_TTS_EDGE_${name}`] ||
    fallback;
  return String(value || fallback).trim();
}

export function edgeSsml(text) {
  const voice = edgeSpeechVoice();
  const rate = edgeProsodyAttribute('RATE', '+0%');
  const pitch = edgeProsodyAttribute('PITCH', '+0Hz');
  const volume = edgeProsodyAttribute('VOLUME', '+0%');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${escapeSsml(voice)}'><prosody pitch='${escapeSsml(pitch)}' rate='${escapeSsml(rate)}' volume='${escapeSsml(volume)}'>${escapeSsml(text)}</prosody></voice></speak>`;
}

export function edgeMessage(path, contentType, body, extraHeaders = {}) {
  const headers = {
    ...extraHeaders,
    'X-Timestamp': new Date().toISOString(),
    'Content-Type': contentType,
    Path: path
  };
  const lines = Object.entries(headers).map(([key, value]) => `${key}:${value}`);
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

export function edgeAudioPayload(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const headerLength = buffer.readUInt16BE(0);
  if (headerLength + 2 > buffer.length) {
    return null;
  }
  const header = buffer.subarray(2, headerLength + 2).toString('utf8');
  if (!/\bPath:audio\b/i.test(header)) {
    return null;
  }
  const payload = buffer.subarray(headerLength + 2);
  return payload.length ? payload : null;
}

export function requestEdgeSpeech(text) {
  return new Promise((resolve, reject) => {
    const connectionId = edgeConnectionId();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}&Sec-MS-GEC=${edgeSecMsGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;
    const chunks = [];
    let settled = false;
    const socket = new WebSocket(url, {
      perMessageDeflate: true,
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        Cookie: `muid=${edgeMuid()};`
      }
    });

    let timer = null;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.close();
      if (error) {
        reject(error);
        return;
      }
      const data = Buffer.concat(chunks);
      if (!data.length) {
        const emptyError = new Error('Edge speech synthesis produced no audio.');
        emptyError.statusCode = 502;
        reject(emptyError);
        return;
      }
      resolve(data);
    };

    timer = setTimeout(() => {
      const error = new Error('Edge speech synthesis timed out.');
      error.statusCode = 504;
      finish(error);
    }, EDGE_SPEECH_TIMEOUT_MS);

    socket.on('open', () => {
      const speechConfig = {
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: false,
                wordBoundaryEnabled: false
              },
              outputFormat: EDGE_SPEECH_FORMAT
            }
          }
        }
      };
      socket.send(edgeMessage('speech.config', 'application/json; charset=utf-8', JSON.stringify(speechConfig)));
      socket.send(edgeMessage('ssml', 'application/ssml+xml', edgeSsml(text), {
        'X-RequestId': edgeConnectionId()
      }));
    });

    socket.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!isBinary) {
        const message = buffer.toString('utf8');
        if (/\bPath:turn\.end\b/i.test(message)) {
          finish();
        }
        return;
      }
      const payload = edgeAudioPayload(buffer);
      if (payload) {
        chunks.push(payload);
      }
    });
    socket.on('error', (error) => {
      error.statusCode ||= 502;
      finish(error);
    });
  });
}

export async function synthesizeEdgeSpeech(text) {
  const data = await requestEdgeSpeech(text);
  return {
    data,
    mimeType: EDGE_SPEECH_MIME_TYPE,
    model: EDGE_SPEECH_FORMAT,
    voice: edgeSpeechVoice(),
    provider: EDGE_SPEECH_PROVIDER
  };
}
