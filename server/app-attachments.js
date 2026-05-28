import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_ROOT } from './app-config.js';

function attachmentError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function safeUploadPath(value) {
  if (String(value || '').includes('\u0000')) {
    throw attachmentError('invalid_attachment_path');
  }
  const resolvedRoot = path.resolve(UPLOAD_ROOT);
  const resolvedPath = path.resolve(String(value || ''));
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw attachmentError('invalid_attachment_path');
  }
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realPath = fs.realpathSync(resolvedPath);
    if (realPath === realRoot || !realPath.startsWith(`${realRoot}${path.sep}`)) {
      throw attachmentError('invalid_attachment_path');
    }
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    throw attachmentError('invalid_attachment_path');
  }
  return resolvedPath;
}

export function normalizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item.path === 'string' && item.path.trim())
    .map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || path.basename(item.path)),
      size: Number(item.size) || 0,
      mimeType: String(item.mimeType || ''),
      path: safeUploadPath(item.path),
      kind: item.kind === 'image' ? 'image' : 'file'
    }));
}

export function withAttachmentReferences(message, attachments) {
  if (!attachments.length) {
    return message;
  }

  const lines = attachments.map((attachment) => {
    const type = attachment.kind === 'image' ? '图片' : '文件';
    return `- ${type}: ${attachment.name} (${attachment.path})`;
  });
  return `${message}\n\n附件路径:\n${lines.join('\n')}`;
}
