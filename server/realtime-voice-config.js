import { PROVIDER_ALIASES, PROVIDER_DEFAULTS } from './realtime-voice-providers.js';

const REALTIME_VAD_SILENCE_MS = Number(process.env.CODEXMOBILE_REALTIME_VAD_SILENCE_MS || 650);
const REALTIME_VAD_THRESHOLD = Number(process.env.CODEXMOBILE_REALTIME_VAD_THRESHOLD || 0.5);
const CLIENT_VAD_SILENCE_MS = Number(process.env.CODEXMOBILE_REALTIME_CLIENT_VAD_SILENCE_MS || 900);
const REALTIME_TIME_ZONE = process.env.CODEXMOBILE_REALTIME_TIME_ZONE || 'Asia/Shanghai';

export const REALTIME_TIMEOUT_MS = Number(process.env.CODEXMOBILE_REALTIME_TIMEOUT_MS || 30000);

export function truthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function safeMessage(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]')
    .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
    .slice(0, 600);
}

export function realtimeErrorMessage(event) {
  return safeMessage(event?.error?.message || event?.error || event?.message || '');
}

export function isBenignRealtimeCancelError(event) {
  return /Conversation has none active response/i.test(realtimeErrorMessage(event));
}

function providerLabel(baseUrl, provider) {
  if (provider === 'dashscope') {
    return '阿里百炼';
  }
  if (provider === 'volcengine') {
    return '火山引擎';
  }
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname || 'custom';
  } catch {
    return 'custom';
  }
}

function normalizeProvider(value) {
  return PROVIDER_ALIASES.get(String(value || '').trim().toLowerCase()) || '';
}

function inferProviderFromBaseUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname.includes('dashscope.aliyuncs.com')) {
      return 'dashscope';
    }
    if (hostname.includes('volces.com') || hostname.includes('volcengine')) {
      return 'volcengine';
    }
  } catch {
    return '';
  }
  return '';
}

export function realtimeProvider() {
  const explicit = normalizeProvider(process.env.CODEXMOBILE_REALTIME_PROVIDER);
  if (explicit) {
    return explicit;
  }
  const model = String(process.env.CODEXMOBILE_REALTIME_MODEL || process.env.CODEXMOBILE_VOICE_REALTIME_MODEL || '').trim();
  if (/^qwen/i.test(model)) {
    return 'dashscope';
  }
  if (/^ag-/i.test(model)) {
    return 'volcengine';
  }
  const baseUrl = process.env.CODEXMOBILE_REALTIME_BASE_URL || process.env.CODEXMOBILE_VOICE_REALTIME_BASE_URL || '';
  const inferred = inferProviderFromBaseUrl(baseUrl);
  if (inferred) {
    return inferred;
  }
  return baseUrl ? 'openai' : 'dashscope';
}

function realtimeDefaults() {
  return PROVIDER_DEFAULTS[realtimeProvider()] || PROVIDER_DEFAULTS.dashscope;
}

export function realtimeBaseUrl() {
  const defaults = realtimeDefaults();
  return process.env.CODEXMOBILE_REALTIME_BASE_URL ||
    process.env.CODEXMOBILE_VOICE_REALTIME_BASE_URL ||
    defaults.baseUrl;
}

export function realtimeModel() {
  const defaults = realtimeDefaults();
  return process.env.CODEXMOBILE_REALTIME_MODEL ||
    process.env.CODEXMOBILE_VOICE_REALTIME_MODEL ||
    defaults.model;
}

export function realtimeApiKey() {
  const shared = process.env.CODEXMOBILE_REALTIME_API_KEY ||
    process.env.CODEXMOBILE_VOICE_REALTIME_API_KEY ||
    '';
  if (shared) {
    return shared;
  }
  if (realtimeProvider() === 'dashscope') {
    return process.env.CODEXMOBILE_DASHSCOPE_REALTIME_API_KEY ||
      process.env.CODEXMOBILE_DASHSCOPE_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      '';
  }
  if (realtimeProvider() === 'volcengine') {
    return process.env.CODEXMOBILE_VOLCENGINE_REALTIME_API_KEY ||
      process.env.VOLCENGINE_API_KEY ||
      process.env.ARK_API_KEY ||
      '';
  }
  return process.env.OPENAI_API_KEY || '';
}

function realtimeVoice() {
  const defaults = realtimeDefaults();
  return process.env.CODEXMOBILE_REALTIME_VOICE ||
    process.env.CODEXMOBILE_VOICE_REALTIME_VOICE ||
    defaults.voice;
}

function realtimeInputSampleRate() {
  return Number(process.env.CODEXMOBILE_REALTIME_INPUT_SAMPLE_RATE) ||
    realtimeDefaults().inputSampleRate;
}

function realtimeOutputSampleRate() {
  return Number(process.env.CODEXMOBILE_REALTIME_OUTPUT_SAMPLE_RATE) ||
    realtimeDefaults().outputSampleRate;
}

function realtimeInputAudioFormat(provider = realtimeProvider()) {
  return process.env.CODEXMOBILE_REALTIME_INPUT_AUDIO_FORMAT ||
    PROVIDER_DEFAULTS[provider]?.inputAudioFormat ||
    'pcm16';
}

function realtimeOutputAudioFormat(provider = realtimeProvider()) {
  return process.env.CODEXMOBILE_REALTIME_OUTPUT_AUDIO_FORMAT ||
    PROVIDER_DEFAULTS[provider]?.outputAudioFormat ||
    'pcm16';
}

function realtimeInstructions() {
  const baseInstructions = process.env.CODEXMOBILE_REALTIME_INSTRUCTIONS ||
    '你是一个低延迟中文语音助手。回答要自然、简短、直接。';
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: REALTIME_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return [
    baseInstructions,
    `当前日期时间：${formatter.format(new Date())}，时区：${REALTIME_TIME_ZONE}。`,
    '如果用户询问日期、时间、今天、明天、昨天，请优先使用这里给出的当前日期时间。',
    '如果用户说“总结/整理/汇总后交给 Codex/代码/助手执行”或类似意思，不要说你做不到；只需简短确认“我来整理”，系统会自动处理。'
  ].join('\n');
}

function realtimeSearchEnabled(provider) {
  return provider === 'dashscope' && truthyEnv(process.env.CODEXMOBILE_REALTIME_ENABLE_SEARCH);
}

export function realtimeWebSocketUrl(baseUrl, model) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') {
    pathname = '/v1';
  }
  if (!pathname.endsWith('/v1') && !pathname.endsWith('/realtime')) {
    pathname = `${pathname}/v1`;
  }
  if (!pathname.endsWith('/realtime')) {
    pathname = `${pathname}/realtime`;
  }
  url.pathname = pathname;
  url.searchParams.set('model', model);
  return url.toString();
}

export function realtimeHeaders(provider, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`
  };
  if (provider === 'openai') {
    headers['OpenAI-Beta'] = 'realtime=v1';
  }
  return headers;
}

export function realtimeSessionPayload(provider) {
  const session = {
    modalities: provider === 'volcengine' || provider === 'dashscope' ? ['text', 'audio'] : ['audio', 'text'],
    instructions: realtimeInstructions(),
    voice: realtimeVoice(),
    input_audio_format: realtimeInputAudioFormat(provider),
    output_audio_format: realtimeOutputAudioFormat(provider)
  };
  if (provider === 'dashscope') {
    session.turn_detection = null;
    session.smooth_output = true;
    if (realtimeSearchEnabled(provider)) {
      session.enable_search = true;
      session.search_options = { enable_source: true };
    }
  } else if (provider === 'volcengine') {
    session.output_audio_sample_rate = realtimeOutputSampleRate();
    session.input_audio_transcription = { model: 'any' };
    session.turn_detection = null;
  } else {
    session.turn_detection = {
      type: 'server_vad',
      threshold: REALTIME_VAD_THRESHOLD,
      prefix_padding_ms: 300,
      silence_duration_ms: REALTIME_VAD_SILENCE_MS
    };
  }
  return {
    type: 'session.update',
    session
  };
}

export function realtimeResponseCreatePayload(provider) {
  return {
    type: 'response.create',
    response: {
      modalities: provider === 'volcengine' || provider === 'dashscope' ? ['text', 'audio'] : ['audio']
    }
  };
}

export function publicVoiceRealtimeStatus() {
  const disabled = truthyEnv(process.env.CODEXMOBILE_REALTIME_DISABLED) ||
    truthyEnv(process.env.CODEXMOBILE_VOICE_REALTIME_DISABLED);
  const apiKey = realtimeApiKey();
  const provider = realtimeProvider();
  const baseUrl = realtimeBaseUrl();
  const defaults = realtimeDefaults();
  return {
    configured: Boolean(!disabled && apiKey),
    disabled,
    provider: providerLabel(baseUrl, provider),
    providerId: provider,
    baseUrlConfigured: Boolean(process.env.CODEXMOBILE_REALTIME_BASE_URL || process.env.CODEXMOBILE_VOICE_REALTIME_BASE_URL),
    model: realtimeModel(),
    cheapest: defaults.cheapest,
    priceHint: defaults.priceHint,
    voice: realtimeVoice(),
    inputSampleRate: realtimeInputSampleRate(),
    outputSampleRate: realtimeOutputSampleRate(),
    inputAudioFormat: realtimeInputAudioFormat(provider),
    outputAudioFormat: realtimeOutputAudioFormat(provider),
    searchEnabled: realtimeSearchEnabled(provider),
    timeZone: REALTIME_TIME_ZONE,
    clientTurnDetection: defaults.clientTurnDetection,
    clientVadSilenceMs: CLIENT_VAD_SILENCE_MS,
    transport: 'server-websocket-proxy'
  };
}
