import {
  DASHSCOPE_SPEECH_PATH,
  DASHSCOPE_SPEECH_PROVIDER,
  SPEECH_TIMEOUT_MS,
  dashscopeSpeechConfig,
  safeProviderMessage
} from './voice-speaker-config.js';

function audioMimeTypeFromUrl(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const extension = pathname.split('.').pop();
    if (extension === 'mp3') {
      return 'audio/mpeg';
    }
    if (extension === 'wav') {
      return 'audio/wav';
    }
    if (extension === 'ogg' || extension === 'opus') {
      return 'audio/ogg';
    }
    if (extension === 'aac') {
      return 'audio/aac';
    }
    if (extension === 'flac') {
      return 'audio/flac';
    }
  } catch {
    return 'audio/wav';
  }
  return 'audio/wav';
}

function dashscopeErrorMessage(payload, response) {
  return payload?.message ||
    payload?.error?.message ||
    payload?.error ||
    payload?.output?.message ||
    `DashScope speech API returned ${response.status}`;
}

async function requestDashscopeSpeech({ text, config, apiKey }) {
  if (!apiKey) {
    const error = new Error('DashScope API key is not configured');
    error.status = 401;
    error.statusCode = 401;
    throw error;
  }

  const input = { text, voice: config.voice };
  if (config.languageType) {
    input.language_type = config.languageType;
  }
  const response = await fetch(`${config.baseUrl}${DASHSCOPE_SPEECH_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, input }),
    signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS)
  });
  const rawText = await response.text();
  const payload = rawText ? JSON.parse(rawText) : null;
  if (!response.ok || payload?.code) {
    const error = new Error(safeProviderMessage(dashscopeErrorMessage(payload, response)));
    error.status = response.status;
    error.statusCode = response.status;
    throw error;
  }
  return downloadDashscopeAudio(payload, config);
}

async function downloadDashscopeAudio(payload, config) {
  const audioUrl = payload?.output?.audio?.url || payload?.output?.url || payload?.audio?.url || '';
  if (!audioUrl) {
    const error = new Error('DashScope speech response did not include an audio URL');
    error.statusCode = 502;
    throw error;
  }
  const response = await fetch(audioUrl, { signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS) });
  if (!response.ok) {
    const error = new Error(`DashScope audio download returned ${response.status}`);
    error.status = response.status;
    error.statusCode = response.status;
    throw error;
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) {
    const error = new Error('DashScope speech produced no audio');
    error.statusCode = 502;
    throw error;
  }
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
  return {
    data,
    mimeType: contentType || audioMimeTypeFromUrl(audioUrl),
    model: config.model,
    voice: config.voice,
    provider: DASHSCOPE_SPEECH_PROVIDER
  };
}

export async function synthesizeDashscopeSpeech(text) {
  const config = dashscopeSpeechConfig();
  const apiKeys = config.apiKeys.length ? config.apiKeys : [''];
  let lastError = null;
  for (let index = 0; index < apiKeys.length; index += 1) {
    try {
      return await requestDashscopeSpeech({ text, config, apiKey: apiKeys[index] });
    } catch (error) {
      lastError = error;
      const invalidKey = error.status === 401 ||
        /invalid api key|incorrect api key|unauthorized|api key/i.test(error.message || '');
      if (invalidKey && index < apiKeys.length - 1) {
        console.warn(`[voice] DashScope API key #${index + 1} failed, trying next key.`);
        continue;
      }
      break;
    }
  }
  throw lastError || new Error('DashScope speech failed');
}
