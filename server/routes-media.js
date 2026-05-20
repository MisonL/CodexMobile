import { getCacheSnapshot } from './codex-data.js';
import { readBody, sendJson } from './http-utils.js';
import { MAX_JSON_BYTES } from './app-config.js';
import { readVoiceUpload, saveUpload } from './app-upload.js';
import { remoteAddress } from './app-auth.js';
import { synthesizeSpeech } from './voice-speaker.js';
import { transcribeAudio } from './voice-transcriber.js';

function safeVoiceMessage(error, fallback) {
  return String(error.message || fallback)
    .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
}

export async function handleMediaRoute(req, res, { method, pathname }) {
  if (method === 'POST' && pathname === '/api/uploads') {
    const upload = await saveUpload(req);
    console.log(`[upload] saved name=${upload.name} size=${upload.size} kind=${upload.kind} remote=${remoteAddress(req)}`);
    sendJson(res, 200, { upload });
    return true;
  }

  if (method === 'POST' && pathname === '/api/voice/transcribe') {
    const startedAt = Date.now();
    try {
      const audio = await readVoiceUpload(req);
      const result = await transcribeAudio(audio, getCacheSnapshot().config || {});
      console.log(`[voice] transcribed size=${audio.data.length} mime=${audio.mimeType} provider=${result.provider} model=${result.model} remote=${remoteAddress(req)}`);
      sendJson(res, 200, { text: result.text || '', durationMs: Date.now() - startedAt });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      const providerInfo = error.providerHost ? ` provider=${error.providerHost}` : '';
      const message = safeVoiceMessage(error, '语音转写失败');
      console.warn(`[voice] transcribe failed status=${statusCode}${providerInfo} remote=${remoteAddress(req)} message=${message}`);
      sendJson(res, statusCode, { error: message || '语音转写失败' });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/voice/speech') {
    await handleSpeech(req, res);
    return true;
  }

  return false;
}

async function handleSpeech(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req, MAX_JSON_BYTES);
    const result = await synthesizeSpeech(body.text, getCacheSnapshot().config || {});
    console.log(`[voice] synthesized bytes=${result.data.length} provider=${result.provider} model=${result.model} voice=${result.voice} remote=${remoteAddress(req)}`);
    res.writeHead(200, {
      'content-type': result.mimeType,
      'content-length': result.data.length,
      'cache-control': 'no-store',
      'x-codexmobile-duration-ms': String(Date.now() - startedAt)
    });
    res.end(result.data);
  } catch (error) {
    const statusCode = error.statusCode || 502;
    const message = safeVoiceMessage(error, '语音合成失败');
    console.warn(`[voice] speech failed status=${statusCode} remote=${remoteAddress(req)} message=${message}`);
    sendJson(res, statusCode, { error: message || '语音合成失败' });
  }
}
