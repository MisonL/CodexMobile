import { getCacheSnapshot, getHostName } from './codex-data.js';
import { getActiveRuns } from './codex-runner.js';
import { publicVoiceRealtimeStatus } from './realtime-voice.js';
import { publicVoiceSpeechStatus } from './voice-speaker.js';
import { publicVoiceTranscriptionStatus } from './voice-transcriber.js';
import { getTrustedDeviceCount } from './auth.js';
import { DEFAULT_REASONING_EFFORT, PORT } from './app-config.js';
import { publicDocsStatus } from './app-feishu-oauth.js';
import { getActiveImageRuns } from './app-turn-state.js';

export function fallbackModels(config) {
  const model = config.model || 'gpt-5.5';
  return [{ value: model, label: model }];
}

export async function publicStatus(authenticated) {
  const snapshot = getCacheSnapshot();
  const config = snapshot.config || {};
  return {
    connected: true,
    hostName: getHostName(),
    port: PORT,
    provider: config.provider || 'codex',
    model: config.model || 'gpt-5.5',
    modelShort: config.modelShort || '5.5 中',
    models: config.models?.length ? config.models : fallbackModels(config),
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    voiceTranscription: publicVoiceTranscriptionStatus(config),
    voiceSpeech: publicVoiceSpeechStatus(config),
    voiceRealtime: publicVoiceRealtimeStatus(config),
    docs: await publicDocsStatus(authenticated),
    syncedAt: snapshot.syncedAt,
    activeRuns: [...getActiveRuns(), ...getActiveImageRuns()],
    auth: {
      required: true,
      authenticated,
      trustedDevices: getTrustedDeviceCount()
    }
  };
}
