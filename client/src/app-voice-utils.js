const SPOKEN_TEXT_MAX_LENGTH = 2400;

export function spokenReplyText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/```[\s\S]*?```/g, ' 代码块 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[#>*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SPOKEN_TEXT_MAX_LENGTH);
}

const MESSAGE_SPEECH_FIRST_SEGMENT_CHARS = 180;
const MESSAGE_SPEECH_SEGMENT_CHARS = 420;

export function splitSpeechSegments(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return [];
  }
  const sentencePattern = /[^.!?;,\u3002\uff01\uff1f\uff1b\uff0c]+[.!?;,\u3002\uff01\uff1f\uff1b\uff0c]?/g;
  const sentences = text.match(sentencePattern) || [text];
  const segments = [];
  let current = '';

  const pushCurrent = () => {
    const segment = current.trim();
    if (segment) {
      segments.push(segment);
    }
    current = '';
  };

  const pushLongText = (chunk, limit) => {
    let rest = chunk.trim();
    while (rest.length > limit) {
      const slice = rest.slice(0, limit).trim();
      if (slice) {
        segments.push(slice);
      }
      rest = rest.slice(limit).trim();
    }
    current = rest;
  };

  for (const sentence of sentences) {
    const chunk = sentence.trim();
    if (!chunk) {
      continue;
    }
    const limit = segments.length ? MESSAGE_SPEECH_SEGMENT_CHARS : MESSAGE_SPEECH_FIRST_SEGMENT_CHARS;
    const next = current ? `${current} ${chunk}` : chunk;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    if (current) {
      pushCurrent();
    }
    if (chunk.length > limit) {
      pushLongText(chunk, limit);
    } else {
      current = chunk;
    }
  }
  pushCurrent();
  return segments;
}

export function voiceDialogStatusLabel(state) {
  const labels = {
    idle: '准备对话',
    listening: '正在听',
    transcribing: '正在转写',
    sending: '正在发送',
    waiting: '等待回复',
    speaking: '正在朗读',
    summarizing: '正在整理任务',
    handoff: '确认交给 Codex',
    error: '对话出错'
  };
  return labels[state] || labels.idle;
}

export function downsampleAudio(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, input.length - 1);
    const weight = sourceIndex - before;
    output[index] = input[before] * (1 - weight) + input[after] * weight;
  }
  return output;
}

export function floatToPcm16Base64(input) {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function pcm16Base64ToFloat(base64) {
  const binary = atob(base64);
  const length = Math.floor(binary.length / 2);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const lo = binary.charCodeAt(index * 2);
    const hi = binary.charCodeAt(index * 2 + 1);
    const value = (hi << 8) | lo;
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    output[index] = Math.max(-1, Math.min(1, signed / 0x8000));
  }
  return output;
}

export function audioLevel(samples) {
  if (!samples?.length) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    total += samples[index] * samples[index];
  }
  return Math.sqrt(total / samples.length);
}
