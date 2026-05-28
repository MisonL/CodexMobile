import path from 'node:path';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_MIN_BYTES = 12;
const WEBP_RIFF_OFFSET = 0;
const WEBP_RIFF_END = 4;
const WEBP_WEBP_OFFSET = 8;
const WEBP_WEBP_END = 12;
const WEBP_RIFF = 'RIFF';
const WEBP_WEBP = 'WEBP';

export function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(html);
}

export function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413, status: 413 }));
        req.destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

export function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(new Error('Upload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

export function parseHeaderValue(value, key) {
  const match = String(value || '').match(new RegExp(`${key}="([^"]*)"`));
  return match ? match[1] : '';
}

export function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || 'upload.bin')).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  return baseName || 'upload.bin';
}

export function hasSupportedImageMagic(data, mimeType) {
  if (/png/i.test(mimeType)) {
    return data.length >= PNG_MAGIC.length &&
      data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
  }
  if (/jpe?g/i.test(mimeType)) {
    return data.length >= JPEG_MAGIC.length &&
      data.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC);
  }
  if (/webp/i.test(mimeType)) {
    return data.length >= WEBP_MIN_BYTES &&
      data.subarray(WEBP_RIFF_OFFSET, WEBP_RIFF_END).toString('ascii') === WEBP_RIFF &&
      data.subarray(WEBP_WEBP_OFFSET, WEBP_WEBP_END).toString('ascii') === WEBP_WEBP;
  }
  return false;
}

export function classifyUpload(mimeType, data = Buffer.alloc(0)) {
  return hasSupportedImageMagic(data, mimeType) ? 'image' : 'file';
}
