import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesizeEdgeSpeech } from './voice-speaker-edge.js';
import {
  DEFAULT_SPEECH_FORMAT,
  LOCAL_SPEECH_PROVIDER,
  LOCAL_SPEECH_STDIO_LIMIT,
  LOCAL_SPEECH_TIMEOUT_MS,
  SPEECH_MAX_INPUT_CHARS,
  WINDOWS_SAPI_SCRIPT,
  edgeSpeechEnabled,
  localSpeechFallbackEnabled,
  localSpeechVoice,
  requestSpeech,
  safeProviderMessage,
  speechMimeType,
  voiceSpeechConfig
} from './voice-speaker-config.js';

export { publicVoiceSpeechStatus, speechMimeType } from './voice-speaker-config.js';

export function runWindowsSapi({ text, outputPath }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_SAPI_SCRIPT
    ], {
      env: {
        ...process.env,
        CODEXMOBILE_SAPI_TEXT: text,
        CODEXMOBILE_SAPI_PATH: outputPath,
        CODEXMOBILE_SAPI_VOICE: localSpeechVoice()
      },
      windowsHide: true
    });

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const append = (current, chunk) => String(current + chunk).slice(-LOCAL_SPEECH_STDIO_LIMIT);
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    timer = setTimeout(() => {
      const error = new Error('Local speech synthesis timed out.');
      error.statusCode = 504;
      child.kill();
      finish(error);
    }, LOCAL_SPEECH_TIMEOUT_MS);

    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = safeProviderMessage(stderr || stdout || `PowerShell exited with code ${code}`);
      const error = new Error(`Local speech synthesis failed: ${detail}`);
      error.statusCode = 502;
      finish(error);
    });
  });
}

export async function synthesizeLocalSpeech(text) {
  const outputPath = path.join(
    os.tmpdir(),
    `codexmobile-speech-${process.pid}-${Date.now()}-${randomUUID()}.wav`
  );

  try {
    await runWindowsSapi({ text, outputPath });
    const data = await fs.readFile(outputPath);
    if (!data.length) {
      const error = new Error('Local speech synthesis produced no audio.');
      error.statusCode = 502;
      throw error;
    }
    return {
      data,
      mimeType: 'audio/wav',
      model: LOCAL_SPEECH_PROVIDER,
      voice: localSpeechVoice() || 'system',
      provider: LOCAL_SPEECH_PROVIDER
    };
  } finally {
    await fs.unlink(outputPath).catch(() => null);
  }
}

export async function synthesizeSpeech(input, codexConfig = {}) {
  if (truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLED)) {
    const error = new Error('语音合成已禁用');
    error.statusCode = 503;
    throw error;
  }

  const text = String(input || '').replace(/\s+/g, ' ').trim().slice(0, SPEECH_MAX_INPUT_CHARS);
  if (!text) {
    const error = new Error('没有可朗读的文字');
    error.statusCode = 400;
    throw error;
  }

  if (edgeSpeechEnabled()) {
    try {
      return await synthesizeEdgeSpeech(text);
    } catch (error) {
      console.warn(`[voice] Edge speech failed, falling back: ${safeProviderMessage(error?.message || '')}`);
    }
  }

  const config = await voiceSpeechConfig(codexConfig);
  const apiKeys = config.apiKeys.length ? config.apiKeys : [''];
  let lastError = null;

  for (let index = 0; index < apiKeys.length; index += 1) {
    try {
      const data = await requestSpeech({ text, config, apiKey: apiKeys[index] });
      return {
        data,
        mimeType: speechMimeType(config.format),
        model: config.model,
        voice: config.voice,
        provider: providerLabel(config.baseUrl)
      };
    } catch (error) {
      lastError = error;
      const invalidKey = error.status === 401 ||
        /invalid api key|incorrect api key|unauthorized/i.test(error.message || '');
      if (invalidKey && index < apiKeys.length - 1) {
        console.warn(`[voice] speech API key #${index + 1} failed, trying next key.`);
        continue;
      }
      break;
    }
  }

  if (localSpeechFallbackEnabled()) {
    console.warn(`[voice] speech provider failed, using ${LOCAL_SPEECH_PROVIDER} fallback: ${safeProviderMessage(lastError?.message || '')}`);
    try {
      return await synthesizeLocalSpeech(text);
    } catch (fallbackError) {
      lastError = fallbackError;
    }
  }

  const finalError = new Error(safeProviderMessage(lastError?.message || '语音合成失败'));
  finalError.statusCode = lastError?.statusCode || lastError?.status || 502;
  throw finalError;
}
