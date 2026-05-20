import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { GENERATED_ROOT } from './image-generator.js';
import { CLIENT_DIST, HTTPS_ROOT_CA_PATH, compressibleExtensions, mimeTypes } from './app-config.js';

export function acceptsGzip(req) {
  return String(req.headers['accept-encoding'] || '')
    .split(',')
    .some((value) => value.trim().toLowerCase().startsWith('gzip'));
}

export function staticCacheControl(ext, filePath = '') {
  if (ext === '.html') {
    return 'no-store';
  }
  const normalized = filePath.split(path.sep).join('/');
  if (normalized.includes('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

export function sendStaticContent(req, res, status, content, headers, ext) {
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

export async function serveFileFromRoot(req, res, rootDir, requestedPath, cacheControl) {
  const relativePath = requestedPath.replace(/^\/+/, '');
  const candidate = path.normalize(path.join(rootDir, relativePath));
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return true;
    }
    const ext = path.extname(candidate);
    const content = await fs.readFile(candidate);
    sendStaticContent(req, res, 200, content, {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff'
    }, ext);
    return true;
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return true;
  }
}

export async function serveStatic(req, res, url) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === '/codexmobile-root-ca.cer') {
    try {
      const stat = await fs.stat(HTTPS_ROOT_CA_PATH);
      const content = await fs.readFile(HTTPS_ROOT_CA_PATH);
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-length': stat.size,
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="codexmobile-root-ca.cer"',
        'x-content-type-options': 'nosniff'
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Certificate not found');
    }
    return;
  }

  if (requestedPath.startsWith('/generated/')) {
    await serveFileFromRoot(
      req,
      res,
      GENERATED_ROOT,
      requestedPath.slice('/generated/'.length),
      'private, max-age=86400'
    );
    return;
  }

  if (requestedPath === '/') {
    requestedPath = '/index.html';
  }

  const candidate = path.normalize(path.join(CLIENT_DIST, requestedPath));
  if (!candidate.startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end('Forbidden');
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
    const indexPath = path.join(CLIENT_DIST, 'index.html');
    try {
      const content = await fs.readFile(indexPath);
      sendStaticContent(req, res, 200, content, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }, '.html');
    } catch {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('CodexMobile server is running. Build the PWA with: npm run build');
    }
  }
}
