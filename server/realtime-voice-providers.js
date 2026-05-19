const OPENAI_REALTIME_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_CHEAPEST_REALTIME_MODEL = 'gpt-4o-mini-realtime-preview-2024-12-17';
const OPENAI_REALTIME_VOICE = 'alloy';
const VOLCENGINE_REALTIME_BASE_URL = 'https://ai-gateway.vei.volces.com/v1';
const VOLCENGINE_REALTIME_MODEL = 'AG-voice-chat-agent';
const VOLCENGINE_REALTIME_VOICE = 'zh_female_tianmeixiaoyuan_moon_bigtts';
const DASHSCOPE_REALTIME_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DASHSCOPE_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime';
const DASHSCOPE_REALTIME_VOICE = 'Tina';

export const PROVIDER_ALIASES = new Map([
  ['ali', 'dashscope'],
  ['aliyun', 'dashscope'],
  ['alibaba', 'dashscope'],
  ['bailian', 'dashscope'],
  ['dashscope', 'dashscope'],
  ['modelstudio', 'dashscope'],
  ['volc', 'volcengine'],
  ['volces', 'volcengine'],
  ['volcengine', 'volcengine'],
  ['ark', 'volcengine'],
  ['openai', 'openai'],
  ['openai-compatible', 'openai'],
  ['compatible', 'openai']
]);

export const PROVIDER_DEFAULTS = {
  dashscope: {
    baseUrl: DASHSCOPE_REALTIME_BASE_URL,
    model: DASHSCOPE_REALTIME_MODEL,
    voice: DASHSCOPE_REALTIME_VOICE,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    inputAudioFormat: 'pcm',
    outputAudioFormat: 'pcm',
    clientTurnDetection: true,
    cheapest: false,
    priceHint: '邀测免费/高智能'
  },
  volcengine: {
    baseUrl: VOLCENGINE_REALTIME_BASE_URL,
    model: VOLCENGINE_REALTIME_MODEL,
    voice: VOLCENGINE_REALTIME_VOICE,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    clientTurnDetection: true,
    cheapest: true,
    priceHint: '火山免费额度'
  },
  openai: {
    baseUrl: OPENAI_REALTIME_BASE_URL,
    model: OPENAI_CHEAPEST_REALTIME_MODEL,
    voice: OPENAI_REALTIME_VOICE,
    inputSampleRate: 24000,
    outputSampleRate: 24000,
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    clientTurnDetection: false,
    cheapest: true,
    priceHint: '最低价'
  }
};
