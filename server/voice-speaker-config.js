import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, openAICompatibleConfig } from './provider-api.js';

export const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_SPEECH_VOICE = 'coral';
export const DEFAULT_SPEECH_FORMAT = 'mp3';
export const SPEECH_TIMEOUT_MS = Number(process.env.CODEXMOBILE_SPEECH_TIMEOUT_MS || 120000);
export const LOCAL_SPEECH_TIMEOUT_MS = Number(process.env.CODEXMOBILE_SPEECH_LOCAL_TIMEOUT_MS || 45000);
export const SPEECH_MAX_INPUT_CHARS = Number(process.env.CODEXMOBILE_SPEECH_MAX_INPUT_CHARS || 4000);
export const EDGE_SPEECH_TIMEOUT_MS = Number(process.env.CODEXMOBILE_SPEECH_EDGE_TIMEOUT_MS || 30000);
export const EDGE_SPEECH_PROVIDER = 'edge-tts';
export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_GEC_VERSION = process.env.CODEXMOBILE_SPEECH_EDGE_GEC_VERSION || '1-143.0.3650.75';
export const DEFAULT_EDGE_SPEECH_VOICE = 'Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)';
export const EDGE_SPEECH_FORMAT = 'webm-24khz-16bit-mono-opus';
export const EDGE_SPEECH_MIME_TYPE = 'audio/webm; codecs=opus';
export const LOCAL_SPEECH_PROVIDER = 'windows-sapi';
export const LOCAL_SPEECH_STDIO_LIMIT = 4000;

export const WINDOWS_SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [Environment]::GetEnvironmentVariable('CODEXMOBILE_SAPI_TEXT', 'Process')
$path = [Environment]::GetEnvironmentVariable('CODEXMOBILE_SAPI_PATH', 'Process')
$voice = [Environment]::GetEnvironmentVariable('CODEXMOBILE_SAPI_VOICE', 'Process')
if ([string]::IsNullOrWhiteSpace($text)) { throw 'No text to speak.' }
if ([string]::IsNullOrWhiteSpace($path)) { throw 'No output path.' }
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if (-not [string]::IsNullOrWhiteSpace($voice)) {
    $synth.SelectVoice($voice)
  }
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
`;

export const SPEECH_MIME_TYPES = new Map([
  ['mp3', 'audio/mpeg'],
  ['opus', 'audio/ogg'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['wav', 'audio/wav'],
  ['pcm', 'audio/L16']
]);

export function truthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function localSpeechFallbackEnabled() {
  return process.platform === 'win32' && !truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLE_LOCAL_FALLBACK);
}

export function edgeSpeechEnabled() {
  return !truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLE_EDGE) &&
    !truthyEnv(process.env.CODEXMOBILE_TTS_DISABLE_EDGE);
}

export function edgeSpeechVoice() {
  return process.env.CODEXMOBILE_SPEECH_EDGE_VOICE ||
    process.env.CODEXMOBILE_TTS_EDGE_VOICE ||
    DEFAULT_EDGE_SPEECH_VOICE;
}

export function localSpeechVoice() {
  return process.env.CODEXMOBILE_SPEECH_LOCAL_VOICE ||
    process.env.CODEXMOBILE_TTS_LOCAL_VOICE ||
    '';
}

export function safeProviderMessage(value) {
  return String(value || '语音合成失败')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]')
    .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
    .slice(0, 500);
}

export function parseErrorText(rawText, response) {
  try {
    const parsed = rawText ? JSON.parse(rawText) : null;
    return parsed?.error?.message || parsed?.error || parsed?.message || `语音合成接口返回 ${response.status}`;
  } catch {
    return rawText || `语音合成接口返回 ${response.status}`;
  }
}

export function providerLabel(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === 'api.openai.com') {
      return 'openai';
    }
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }
    return parsed.hostname || 'custom';
  } catch {
    return 'custom';
  }
}

export function normalizeSpeechFormat(value) {
  const format = String(value || DEFAULT_SPEECH_FORMAT).trim().toLowerCase();
  return SPEECH_MIME_TYPES.has(format) ? format : DEFAULT_SPEECH_FORMAT;
}

export function speechApiKeys() {
  return [
    process.env.CODEXMOBILE_SPEECH_API_KEY,
    process.env.CODEXMOBILE_TTS_API_KEY,
    process.env.OPENAI_API_KEY
  ].filter(Boolean);
}

export async function voiceSpeechConfig(config = {}) {
  const baseUrl = process.env.CODEXMOBILE_SPEECH_BASE_URL ||
    process.env.CODEXMOBILE_TTS_BASE_URL ||
    config.baseUrl;
  const providerConfig = await openAICompatibleConfig({
    baseUrl,
    defaultBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    apiKeys: speechApiKeys()
  });

  return {
    ...providerConfig,
    model: process.env.CODEXMOBILE_SPEECH_MODEL ||
      process.env.CODEXMOBILE_TTS_MODEL ||
      DEFAULT_SPEECH_MODEL,
    voice: process.env.CODEXMOBILE_SPEECH_VOICE ||
      process.env.CODEXMOBILE_TTS_VOICE ||
      DEFAULT_SPEECH_VOICE,
    format: normalizeSpeechFormat(
      process.env.CODEXMOBILE_SPEECH_FORMAT ||
      process.env.CODEXMOBILE_TTS_FORMAT ||
      DEFAULT_SPEECH_FORMAT
    ),
    instructions: process.env.CODEXMOBILE_SPEECH_INSTRUCTIONS ||
      process.env.CODEXMOBILE_TTS_INSTRUCTIONS ||
      ''
  };
}

export function speechMimeType(format) {
  return SPEECH_MIME_TYPES.get(normalizeSpeechFormat(format)) || SPEECH_MIME_TYPES.get(DEFAULT_SPEECH_FORMAT);
}

export function publicVoiceSpeechStatus(config = {}) {
  const baseUrl = process.env.CODEXMOBILE_SPEECH_BASE_URL ||
    process.env.CODEXMOBILE_TTS_BASE_URL ||
    config.baseUrl ||
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
  const localFallback = localSpeechFallbackEnabled();
  const edge = edgeSpeechEnabled();

  return {
    configured: !truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLED),
    provider: edge ? EDGE_SPEECH_PROVIDER : providerLabel(baseUrl),
    model: edge ? EDGE_SPEECH_FORMAT : process.env.CODEXMOBILE_SPEECH_MODEL ||
      process.env.CODEXMOBILE_TTS_MODEL ||
      DEFAULT_SPEECH_MODEL,
    voice: edge ? edgeSpeechVoice() : process.env.CODEXMOBILE_SPEECH_VOICE ||
      process.env.CODEXMOBILE_TTS_VOICE ||
      DEFAULT_SPEECH_VOICE,
    format: edge ? 'webm' : normalizeSpeechFormat(
      process.env.CODEXMOBILE_SPEECH_FORMAT ||
      process.env.CODEXMOBILE_TTS_FORMAT ||
      DEFAULT_SPEECH_FORMAT
    ),
    edge,
    edgeVoice: edge ? edgeSpeechVoice() : '',
    edgeFormat: edge ? EDGE_SPEECH_FORMAT : '',
    localFallback,
    localFallbackProvider: localFallback ? LOCAL_SPEECH_PROVIDER : ''
  };
}

export async function requestSpeech({ text, config, apiKey }) {
  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
  const body = {
    model: config.model,
    input: text,
    voice: config.voice,
    response_format: config.format
  };
  if (config.instructions) {
    body.instructions = config.instructions;
  }

  const response = await fetch(`${config.baseUrl}/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS)
  });

  if (!response.ok) {
    const rawText = await response.text();
    const error = new Error(safeProviderMessage(parseErrorText(rawText, response)));
    error.status = response.status;
    throw error;
  }

  const audioBuffer = await response.arrayBuffer();
  const audioData = Buffer.from(audioBuffer);
  if (!audioData.length) {
    const error = new Error('语音合成接口未返回音频数据');
    error.status = 502;
    error.statusCode = 502;
    throw error;
  }

  return audioData;
}
