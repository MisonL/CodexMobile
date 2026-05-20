import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readMobileSessionMessages, registerMobileSession } from './mobile-session-index.js';
import { GENERATED_ROOT, imageMimeToExt } from './image-generator-api.js';

export async function saveGeneratedImages(images) {
  const folder = GENERATED_ROOT;
  await fs.mkdir(folder, { recursive: true });

  const saved = [];
  for (const image of images) {
    const mimeType = image.mimeType || 'image/png';
    const ext = imageMimeToExt(mimeType);
    const id = crypto.randomUUID();
    const fileName = `${id}.${ext}`;
    const filePath = path.join(folder, fileName);
    const buffer = Buffer.from(String(image.b64 || '').replace(/\s/g, ''), 'base64');
    await fs.writeFile(filePath, buffer);
    saved.push({
      id,
      mimeType,
      path: filePath,
      url: `/generated/${fileName}`,
      revisedPrompt: image.revisedPrompt || ''
    });
  }
  return saved;
}

export function buildAssistantContent(savedImages) {
  const lines = savedImages.flatMap((image, index) => [
    `![生成图片 ${index + 1}](${image.url})`,
    image.revisedPrompt ? `优化提示词：${image.revisedPrompt}` : ''
  ]).filter(Boolean);
  return `已生成图片：\n\n${lines.join('\n\n')}`;
}

export function emitStatus(emit, { sessionId, turnId, kind, status = 'running', label, detail = '' }) {
  emit({
    type: 'status-update',
    sessionId,
    turnId,
    kind,
    status,
    label,
    detail,
    timestamp: new Date().toISOString()
  });
}

export async function appendMobileMessages({ sessionId, projectPath, title, summary, updatedAt, messages }) {
  const existingMessages = await readMobileSessionMessages(sessionId);
  const merged = [...existingMessages];
  for (const message of messages) {
    if (!merged.some((item) => item.id === message.id)) {
      merged.push(message);
    }
  }
  await registerMobileSession({
    id: sessionId,
    projectPath,
    title,
    summary,
    updatedAt,
    messages: merged
  });
}
