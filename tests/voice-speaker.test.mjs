import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createLocalSpeechOutputPath,
  synthesizeSpeech
} from '../server/voice-speaker.js';

const SPEECH_PROVIDER_ENV = {
  CODEXMOBILE_SPEECH_DISABLE_EDGE: '1',
  CODEXMOBILE_SPEECH_DISABLE_LOCAL_FALLBACK: '1',
  CODEXMOBILE_SPEECH_BASE_URL: 'http://127.0.0.1:12345',
  CODEXMOBILE_SPEECH_MODEL: 'test-tts',
  CODEXMOBILE_SPEECH_VOICE: 'test-voice',
  CODEXMOBILE_SPEECH_API_KEY: ''
};

async function withSpeechProvider(fetchImpl, action, env = {}) {
  const previousEnv = process.env;
  const previousFetch = globalThis.fetch;
  process.env = {
    ...previousEnv,
    ...SPEECH_PROVIDER_ENV,
    ...env
  };
  globalThis.fetch = fetchImpl;

  try {
    return await action();
  } finally {
    process.env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

test('local speech output path uses a unique wav file in temp directory', () => {
  const outputPath = createLocalSpeechOutputPath();

  assert.equal(path.dirname(outputPath), os.tmpdir());
  assert.match(path.basename(outputPath), /^codexmobile-speech-\d+-\d+-[0-9a-f-]{36}\.wav$/);
});

test('synthesizeSpeech returns a provider response without missing helper references', async () => {
  await withSpeechProvider(async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('audio')
  }), async () => {
    const result = await synthesizeSpeech('hello');

    assert.equal(result.provider, '127.0.0.1:12345');
    assert.equal(result.model, 'test-tts');
    assert.equal(result.voice, 'test-voice');
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.deepEqual(result.data, Buffer.from('audio'));
  });
});

test('synthesizeSpeech reports provider HTTP errors', async () => {
  await withSpeechProvider(async () => new Response(
    JSON.stringify({ error: { message: 'forbidden speech' } }),
    { status: 403 }
  ), async () => {
    await assert.rejects(synthesizeSpeech('hello'), (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /forbidden speech/);
      return true;
    });
  });
});

test('synthesizeSpeech reports provider authentication errors', async () => {
  await withSpeechProvider(async () => new Response(
    JSON.stringify({ error: { message: 'invalid api key' } }),
    { status: 401 }
  ), async () => {
    await assert.rejects(synthesizeSpeech('hello'), (error) => {
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /invalid api key/i);
      return true;
    });
  });
});

test('synthesizeSpeech reports network failures', async () => {
  await withSpeechProvider(async () => {
    throw new Error('network down');
  }, async () => {
    await assert.rejects(synthesizeSpeech('hello'), (error) => {
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /network down/);
      return true;
    });
  });
});

test('synthesizeSpeech reports empty provider audio bodies', async () => {
  await withSpeechProvider(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0)
  }), async () => {
    await assert.rejects(synthesizeSpeech('hello'), (error) => {
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /未返回音频数据/);
      return true;
    });
  });
});

test('synthesizeSpeech passes a timeout signal to provider fetch', async () => {
  let signal = null;
  await withSpeechProvider(async (url, options) => {
    signal = options.signal;
    const error = new Error('The operation was aborted');
    error.name = 'TimeoutError';
    throw error;
  }, async () => {
    await assert.rejects(synthesizeSpeech('hello'), (error) => {
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /aborted/i);
      return true;
    });
  });

  assert.ok(signal instanceof AbortSignal);
});
