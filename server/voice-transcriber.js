import {
  FALLBACK_OPENAI_TRANSCRIBE_MODEL,
  TRANSCRIBE_TIMEOUT_MS,
  defaultModelForBaseUrl,
  isNetworkFailure,
  isOpenAIBaseUrl,
  keysForBaseUrl,
  languageForProvider,
  normalizeTranscriptText,
  parseErrorText,
  providerMessage,
  shouldFallbackOpenAIModel,
  statusForError,
  voiceTranscriptionConfig
} from './voice-transcriber-config.js';

export { publicVoiceTranscriptionStatus, voiceTranscriptionConfig } from './voice-transcriber-config.js';

export async function requestTranscription({ audio, config, apiKey, model }) {
  const form = new FormData();
  if (model) {
    form.append('model', model);
  }
  form.append('language', languageForProvider(config));
  if (isOpenAIBaseUrl(config.baseUrl) && process.env.CODEXMOBILE_TRANSCRIBE_PROMPT) {
    form.append('prompt', process.env.CODEXMOBILE_TRANSCRIBE_PROMPT);
  }
  form.append('response_format', 'json');
  if (isOpenAIBaseUrl(config.baseUrl)) {
    form.append('temperature', '0');
  }
  form.append('file', new Blob([audio.data], { type: audio.mimeType }), audio.fileName);

  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
  });
  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(safeProviderMessage(parseErrorText(bodyText, response)));
    error.status = response.status;
    throw error;
  }
  return parseTranscriptionText(bodyText);
}

export function candidateModels(providerConfig, requestedModel) {
  if (providerConfig.source === 'openai' || isOpenAIBaseUrl(providerConfig.baseUrl)) {
    return requestedModel === FALLBACK_OPENAI_TRANSCRIBE_MODEL
      ? [requestedModel]
      : [requestedModel, FALLBACK_OPENAI_TRANSCRIBE_MODEL];
  }
  return [requestedModel];
}

export async function transcribeAudio(audio, codexConfig = {}) {
  const providerConfig = await voiceTranscriptionConfig(codexConfig);
  const requestedModel = providerConfig.model || defaultModelForBaseUrl(providerConfig.baseUrl);
  const models = candidateModels(providerConfig, requestedModel);
  const apiKeys = providerConfig.apiKeys.length ? providerConfig.apiKeys : [''];
  let lastError = null;

  for (const model of models) {
    for (let index = 0; index < apiKeys.length; index += 1) {
      try {
        const text = await requestTranscription({
          audio,
          config: providerConfig,
          apiKey: apiKeys[index],
          model
        });
        return { text, model, provider: providerConfig.provider };
      } catch (error) {
        lastError = error;
        const invalidKey = error.status === 401 || /invalid api key|incorrect api key|unauthorized/i.test(error.message || '');
        if (invalidKey && index < apiKeys.length - 1) {
          console.warn(`[voice] API key #${index + 1} failed, trying next key.`);
          continue;
        }
        if (
          isOpenAIBaseUrl(providerConfig.baseUrl) &&
          model !== FALLBACK_OPENAI_TRANSCRIBE_MODEL &&
          shouldFallbackOpenAIModel(error.status, error.message)
        ) {
          break;
        }
        const nextError = new Error(providerMessage(error, providerConfig));
        nextError.status = statusForError(error, providerConfig);
        nextError.provider = providerConfig.provider;
        nextError.providerHost = providerHost(providerConfig.baseUrl);
        throw nextError;
      }
    }
  }

  const finalError = new Error(providerMessage(lastError, providerConfig));
  finalError.status = statusForError(lastError, providerConfig);
  finalError.provider = providerConfig.provider;
  finalError.providerHost = providerHost(providerConfig.baseUrl);
  throw finalError;
}
