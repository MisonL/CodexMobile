import crypto from 'node:crypto';

export function createBrowserTokenCache({ ttlMs }) {
  const entries = new Map();

  function key(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function cleanup() {
    const now = Date.now();
    for (const [tokenKey, entry] of entries.entries()) {
      if (!entry.expiresAt || entry.expiresAt <= now) {
        entries.delete(tokenKey);
      }
    }
  }

  function has(token) {
    if (!token) {
      return false;
    }
    cleanup();
    const cached = entries.get(key(token));
    return Boolean(cached && cached.expiresAt > Date.now());
  }

  function setValid(token) {
    entries.set(key(token), { expiresAt: Date.now() + ttlMs });
  }

  return {
    cleanup,
    has,
    key,
    setValid
  };
}
