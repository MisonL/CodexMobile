import crypto from 'node:crypto';
import { readMobileSessionMessages, registerMobileSession } from './mobile-session-index.js';
import {
  IMAGE_FALLBACK_MAX_ATTEMPTS,
  IMAGE_MAX_ATTEMPTS,
  IMAGE_RETRY_BASE_DELAY_MS,
  buildFallbackGenerationPrompt,
  canFallbackEditToGeneration,
  detectImageIntent,
  isImageRequest,
  isTransientImageError,
  requestImageGeneration,
  safeErrorMessage,
  sleep
} from './image-generator-api.js';
import { appendMobileMessages, buildAssistantContent, emitStatus, saveGeneratedImages } from './image-generator-store.js';

export { GENERATED_ROOT, isImageRequest } from './image-generator-api.js';

export async function runImageTurn({
  sessionId,
  previousSessionId,
  projectPath,
  message,
  attachments = [],
  config,
  turnId,
  persistMobileSession = false
}, emit) {
  const finalSessionId = sessionId || `mobile-image-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();

  if (previousSessionId && previousSessionId !== finalSessionId) {
    emit({
      type: 'thread-started',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      projectPath,
      startedAt
    });
  }

  emit({
    type: 'chat-started',
    sessionId: finalSessionId,
    previousSessionId,
    turnId,
    projectPath,
    startedAt
  });
  emitStatus(emit, {
    sessionId: finalSessionId,
    turnId,
    kind: 'image_generation_call',
    status: 'running',
    label: attachments.some((attachment) => attachment.kind === 'image') ? '正在编辑图片' : '正在生成图片',
    detail: ''
  });

  if (persistMobileSession) {
    await appendMobileMessages({
      sessionId: finalSessionId,
      projectPath,
      title: message.slice(0, 52) || 'Image task',
      summary: message || 'Image task',
      updatedAt: startedAt,
      messages: [
        {
          id: `user-${turnId}`,
          role: 'user',
          content: message,
          timestamp: startedAt
        }
      ]
    });
  }

  try {
    const primaryIntent = detectImageIntent(message, attachments) || 'generate';
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await requestImageGeneration({ prompt: message, attachments, config });
        break;
      } catch (error) {
        lastError = error;
        const canFallback = canFallbackEditToGeneration({ intent: primaryIntent, attachments, error });
        if (attempt >= IMAGE_MAX_ATTEMPTS && canFallback) {
          break;
        }
        if (attempt >= IMAGE_MAX_ATTEMPTS || !isTransientImageError(error)) {
          throw error;
        }
        const detail = safeErrorMessage(error);
        emitStatus(emit, {
          sessionId: finalSessionId,
          turnId,
          kind: 'image_generation_call',
          status: 'running',
          label: `图片接口断流，正在重试 ${attempt + 1}/${IMAGE_MAX_ATTEMPTS}`,
          detail
        });
        emit({
          type: 'activity-update',
          sessionId: finalSessionId,
          turnId,
          messageId: `retry-${turnId}-${attempt}`,
          kind: 'image_generation_call',
          label: `图片接口断流，正在重试 ${attempt + 1}/${IMAGE_MAX_ATTEMPTS}`,
          status: 'running',
          detail,
          timestamp: new Date().toISOString()
        });
        await sleep(IMAGE_RETRY_BASE_DELAY_MS * attempt);
      }
    }
    if (!result && canFallbackEditToGeneration({ intent: primaryIntent, attachments, error: lastError })) {
      const fallbackPrompt = buildFallbackGenerationPrompt(message, attachments, lastError);
      const fallbackDetail = safeErrorMessage(lastError);
      emitStatus(emit, {
        sessionId: finalSessionId,
        turnId,
        kind: 'image_generation_call',
        status: 'running',
        label: '图片编辑接口断流，正在改为重绘出图',
        detail: fallbackDetail
      });
      emit({
        type: 'activity-update',
        sessionId: finalSessionId,
        turnId,
        messageId: `fallback-${turnId}`,
        kind: 'image_generation_call',
        label: '图片编辑接口断流，正在改为重绘出图',
        status: 'running',
        detail: fallbackDetail,
        timestamp: new Date().toISOString()
      });

      for (let attempt = 1; attempt <= IMAGE_FALLBACK_MAX_ATTEMPTS; attempt += 1) {
        try {
          result = await requestImageGeneration({
            prompt: fallbackPrompt,
            attachments: [],
            config,
            forceGenerate: true
          });
          result.fallbackFromEdit = true;
          result.originalError = fallbackDetail;
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= IMAGE_FALLBACK_MAX_ATTEMPTS || !isTransientImageError(error)) {
            throw error;
          }
          const detail = safeErrorMessage(error);
          emitStatus(emit, {
            sessionId: finalSessionId,
            turnId,
            kind: 'image_generation_call',
            status: 'running',
            label: `重绘出图断流，正在重试 ${attempt + 1}/${IMAGE_FALLBACK_MAX_ATTEMPTS}`,
            detail
          });
          await sleep(IMAGE_RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }
    if (!result) {
      throw lastError || new Error('图片生成失败');
    }
    const savedImages = await saveGeneratedImages(result.images);
    let assistantContent = buildAssistantContent(savedImages);
    if (result.fallbackFromEdit) {
      assistantContent = `图片编辑接口连续断流，已自动改为重绘出图。\n\n${assistantContent}`;
    }
    const completedAt = new Date().toISOString();

    emit({
      type: 'activity-update',
      sessionId: finalSessionId,
      turnId,
      messageId: `activity-${turnId}`,
      kind: 'image_generation_call',
      label: result.fallbackFromEdit ? '重绘出图完成' : result.intent === 'edit' ? '图片编辑完成' : '图片生成完成',
      status: 'completed',
      detail: `model: ${result.model}`,
      timestamp: completedAt
    });
    emit({
      type: 'assistant-update',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      messageId: `assistant-${turnId}`,
      role: 'assistant',
      kind: 'image_generation_result',
      content: assistantContent,
      done: true
    });

    if (persistMobileSession) {
      const existingMessages = await readMobileSessionMessages(finalSessionId);
      await registerMobileSession({
        id: finalSessionId,
        projectPath,
        title: message.slice(0, 52) || '图片生成',
        summary: message || '图片生成',
        updatedAt: completedAt,
        messages: [
          ...existingMessages,
          {
            id: `user-${turnId}`,
            role: 'user',
            content: message,
            timestamp: startedAt
          },
          {
            id: `assistant-${turnId}`,
            role: 'assistant',
            content: assistantContent,
            timestamp: completedAt
          }
        ]
      });
    }

    emit({
      type: 'chat-complete',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      usage: result.usage,
      hadAssistantText: true,
      completedAt
    });
  } catch (error) {
    const messageText = safeErrorMessage(error);
    console.error('[image] Generation failed:', messageText);
    if (persistMobileSession) {
      const failedAt = new Date().toISOString();
      await appendMobileMessages({
        sessionId: finalSessionId,
        projectPath,
        title: message.slice(0, 52) || 'Image task',
        summary: message || 'Image task',
        updatedAt: failedAt,
        messages: [
          {
            id: `assistant-${turnId}`,
            role: 'assistant',
            content: `Image task failed: ${messageText}`,
            timestamp: failedAt
          }
        ]
      });
    }
    emit({
      type: 'activity-update',
      sessionId: finalSessionId,
      turnId,
      messageId: `activity-${turnId}`,
      kind: 'image_generation_call',
      label: '图片生成失败',
      status: 'failed',
      detail: messageText,
      error: messageText,
      timestamp: new Date().toISOString()
    });
    emitStatus(emit, {
      sessionId: finalSessionId,
      turnId,
      kind: 'image_generation_call',
      status: 'failed',
      label: '图片生成失败',
      detail: messageText
    });
    emit({
      type: 'chat-error',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      error: messageText
    });
  }

  return finalSessionId;
}
