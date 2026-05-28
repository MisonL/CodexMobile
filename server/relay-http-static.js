import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
]);

const compressibleExtensions = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(String(text || ''));
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    ...headers
  });
  res.end(body);
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
}

function staticCacheControl(ext, filePath = '') {
  if (ext === '.html') {
    return 'no-store';
  }
  return filePath.split(path.sep).join('/').includes('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600';
}

function sendStaticContent(req, res, status, content, headers, ext) {
  let body = content;
  const nextHeaders = { ...headers };
  if (content.length >= 1024 && compressibleExtensions.has(ext) && acceptsGzip(req)) {
    body = gzipSync(content);
    nextHeaders['content-encoding'] = 'gzip';
    nextHeaders.vary = nextHeaders.vary ? `${nextHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
  }
  nextHeaders['content-length'] = body.length;
  res.writeHead(status, nextHeaders);
  res.end(body);
}

export async function serveStatic(req, res, url, clientDist) {
  let requestedPath = '';
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }
  if (requestedPath === '/') {
    requestedPath = '/index.html';
  }
  const candidate = path.normalize(path.join(clientDist, requestedPath));
  if (candidate !== clientDist && !candidate.startsWith(`${clientDist}${path.sep}`)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(candidate);
    const filePath = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate;
    const ext = path.extname(filePath);
    const content = await fs.readFile(filePath);
    sendStaticContent(req, res, 200, content, {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'cache-control': staticCacheControl(ext, filePath),
      'x-content-type-options': 'nosniff'
    }, ext);
  } catch {
    await serveStaticFallback(req, res, clientDist);
  }
}

async function serveStaticFallback(req, res, clientDist) {
  const indexPath = path.join(clientDist, 'index.html');
  try {
    const content = await fs.readFile(indexPath);
    sendStaticContent(req, res, 200, content, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }, '.html');
  } catch {
    sendText(res, 200, 'CodexMobile relay is running. Build the PWA with: npm run build');
  }
}
