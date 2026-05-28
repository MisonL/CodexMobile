import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyUpload, parseHeaderValue, readBuffer, sanitizeFileName } from './http-utils.js';
import { MAX_UPLOAD_BYTES, MAX_VOICE_BYTES, UPLOAD_ROOT } from './app-config.js';

export function parseMultipartFile(buffer, contentType, fieldName = 'file') {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) {
    throw new Error('Missing multipart boundary');
  }
  const acceptedNames = Array.isArray(fieldName) ? fieldName : [fieldName];

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(boundaryBuffer);

  while (cursor >= 0) {
    cursor += boundaryBuffer.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) {
      break;
    }
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) {
      cursor += 2;
    }

    const nextBoundary = buffer.indexOf(boundaryBuffer, cursor);
    if (nextBoundary < 0) {
      break;
    }

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0 || headerEnd > nextBoundary) {
      cursor = nextBoundary;
      continue;
    }

    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const disposition = headers.match(/^content-disposition:\s*(.+)$/im)?.[1] || '';
    const name = parseHeaderValue(disposition, 'name');
    const fileName = parseHeaderValue(disposition, 'filename');
    const mimeType = headers.match(/^content-type:\s*(.+)$/im)?.[1]?.trim() || 'application/octet-stream';

    if (acceptedNames.includes(name) && fileName) {
      let contentEnd = nextBoundary;
      if (buffer[contentEnd - 2] === 13 && buffer[contentEnd - 1] === 10) {
        contentEnd -= 2;
      }
      return {
        fileName: sanitizeFileName(fileName),
        mimeType,
        data: buffer.slice(headerEnd + 4, contentEnd)
      };
    }

    cursor = nextBoundary;
  }

  throw new Error('No file field found');
}

export async function readVoiceUpload(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    const error = new Error('multipart/form-data is required');
    error.statusCode = 400;
    throw error;
  }

  let body;
  try {
    body = await readBuffer(req, MAX_VOICE_BYTES);
  } catch (error) {
    const next = new Error(error.message === 'Upload too large' ? '音频超过 10MB' : '读取音频失败');
    next.statusCode = error.message === 'Upload too large' ? 413 : 400;
    throw next;
  }

  let part;
  try {
    part = parseMultipartFile(body, contentType, 'audio');
  } catch {
    const error = new Error('没有收到音频');
    error.statusCode = 400;
    throw error;
  }

  if (!part.data?.length) {
    const error = new Error('没有收到音频');
    error.statusCode = 400;
    throw error;
  }
  if (!String(part.mimeType || '').toLowerCase().startsWith('audio/')) {
    const error = new Error('音频格式不支持');
    error.statusCode = 400;
    throw error;
  }

  return part;
}

export async function saveUpload(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new Error('multipart/form-data is required');
  }

  const body = await readBuffer(req, MAX_UPLOAD_BYTES);
  const part = parseMultipartFile(body, contentType);
  const id = crypto.randomUUID();
  const dateFolder = new Date().toISOString().slice(0, 10);
  const filePath = path.join(UPLOAD_ROOT, dateFolder, `${id}-${part.fileName}`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, part.data);

  return {
    id,
    name: part.fileName,
    size: part.data.length,
    mimeType: part.mimeType,
    path: filePath,
    kind: classifyUpload(part.mimeType, part.data)
  };
}
