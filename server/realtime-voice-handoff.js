import { realtimeErrorMessage, safeMessage } from './realtime-voice-config.js';

export function normalizeHandoffTranscripts(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-30);
}

function realtimeHandoffPrompt(transcripts) {
  const spokenNotes = transcripts.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    '你现在只做任务整理，不要回答用户问题。',
    '请把下面连续口语想法整理成一个可交给 Codex 执行的明确中文任务。',
    '只输出 JSON，不要 Markdown，不要解释。',
    'JSON 字段固定为：taskTitle、task、keyPoints、constraints。',
    'task 是一句明确可执行的任务；keyPoints 和 constraints 必须是字符串数组；没有约束时 constraints 为空数组。',
    '口语想法：',
    spokenNotes
  ].join('\n');
}

export function realtimeHandoffResponseCreatePayload(provider, transcripts) {
  return {
    type: 'response.create',
    response: {
      modalities: ['text'],
      instructions: realtimeHandoffPrompt(transcripts)
    }
  };
}

export function handoffEventText(event) {
  return String(
    event?.delta ||
      event?.text ||
      event?.transcript ||
      event?.part?.text ||
      event?.item?.content?.text ||
      ''
  );
}

function extractJsonObjectText(text) {
  const value = String(text || '').trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return candidate.slice(start, end + 1);
  }
  return candidate;
}

export function parseHandoffSummary(text) {
  try {
    const parsed = JSON.parse(extractJsonObjectText(text));
    return {
      taskTitle: String(parsed.taskTitle || '').trim(),
      task: String(parsed.task || '').trim(),
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      constraints: Array.isArray(parsed.constraints)
        ? parsed.constraints.map((item) => String(item || '').trim()).filter(Boolean)
        : []
    };
  } catch {
    return null;
  }
}

export function formatCodexHandoffMessage(summary, fallbackText) {
  if (!summary?.task) {
    return String(fallbackText || '').trim();
  }
  const lines = [
    '请执行下面任务：',
    '',
    '目标：',
    summary.task,
    '',
    '关键要点：'
  ];
  const keyPoints = summary.keyPoints.length ? summary.keyPoints : [summary.taskTitle || summary.task];
  for (const item of keyPoints) {
    lines.push(`- ${item}`);
  }
  lines.push('', '约束：');
  const constraints = summary.constraints.length ? summary.constraints : ['无额外约束'];
  for (const item of constraints) {
    lines.push(`- ${item}`);
  }
  return lines.join('\n').trim();
}

export function createRealtimeHandoffController({ provider, sendClient, sendUpstream, getResponseActive, setResponseActive }) {
  const handoff = {
    active: false,
    pendingTranscripts: null,
    text: ''
  };

  const clearHandoff = () => {
    handoff.active = false;
    handoff.pendingTranscripts = null;
    handoff.text = '';
  };

  const sendHandoffError = (error) => {
    sendClient({
      type: 'voice.handoff.summary_error',
      error: safeMessage(error || '语音任务整理失败')
    });
    clearHandoff();
  };

  const begin = (transcripts) => {
    const normalized = normalizeHandoffTranscripts(transcripts);
    if (!normalized.length) {
      sendHandoffError('还没有可整理的语音内容');
      return;
    }
    handoff.active = true;
    handoff.pendingTranscripts = null;
    handoff.text = '';
    sendClient({ type: 'voice.handoff.summarizing', count: normalized.length });
    if (sendUpstream(realtimeHandoffResponseCreatePayload(provider, normalized)) === false) {
      clearHandoff();
      return;
    }
    setResponseActive(true);
  };

  const request = (transcripts) => {
    const normalized = normalizeHandoffTranscripts(transcripts);
    if (!normalized.length) {
      sendHandoffError('还没有可整理的语音内容');
      return;
    }
    handoff.pendingTranscripts = normalized;
    handoff.text = '';
    sendClient({ type: 'voice.handoff.summarizing', count: normalized.length });
    if (getResponseActive()) {
      if (sendUpstream({ type: 'response.cancel' }) === false) {
        clearHandoff();
      }
      return;
    }
    begin(normalized);
  };

  const finish = () => {
    const rawText = handoff.text.trim();
    const summary = parseHandoffSummary(rawText);
    sendClient({
      type: 'voice.handoff.summary_done',
      parsed: Boolean(summary),
      summary,
      rawText,
      message: formatCodexHandoffMessage(summary, rawText)
    });
    clearHandoff();
  };

  const handleEvent = (event) => {
    if (!handoff.active) {
      if (event.type === 'error' && handoff.pendingTranscripts) {
        sendHandoffError(realtimeErrorMessage(event));
        return true;
      }
      return false;
    }
    if (event.type === 'error') {
      sendHandoffError(realtimeErrorMessage(event));
      return true;
    }
    if (
      event.type === 'response.text.delta' ||
      event.type === 'response.output_text.delta' ||
      event.type === 'response.audio_transcript.delta' ||
      event.type === 'response.output_audio_transcript.delta' ||
      event.type === 'response.content_part.delta'
    ) {
      const delta = handoffEventText(event);
      if (delta) {
        handoff.text += delta;
        sendClient({ type: 'voice.handoff.summary_delta', delta });
      }
      return true;
    }
    if (
      event.type === 'response.text.done' ||
      event.type === 'response.output_text.done' ||
      event.type === 'response.audio_transcript.done' ||
      event.type === 'response.output_audio_transcript.done' ||
      event.type === 'response.content_part.done' ||
      event.type === 'response.output_item.done'
    ) {
      const textPart = handoffEventText(event);
      if (textPart && !handoff.text.includes(textPart)) {
        handoff.text += textPart;
      }
      return true;
    }
    if (event.type === 'response.done') {
      setResponseActive(false);
      finish();
      return true;
    }
    return event.type?.startsWith?.('response.');
  };

  return {
    beginPending: () => {
      if (!handoff.pendingTranscripts) {
        return false;
      }
      begin(handoff.pendingTranscripts);
      return true;
    },
    handleEvent,
    request
  };
}
