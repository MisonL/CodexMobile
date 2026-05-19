import crypto from 'node:crypto';

export function clientIpFromRequest(req, trustProxy = false) {
  const remoteAddress = req.socket?.remoteAddress || 'unknown';
  if (!trustProxy) {
    return remoteAddress;
  }
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
  return forwardedFor || remoteAddress;
}

export function tokenRateLimitKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 24);
}

export function browserTokenRequestLimitKey(token) {
  return `token-request:${tokenRateLimitKey(token)}`;
}

export function createMemoryRateLimiter({ maxBuckets = 5000 } = {}) {
  const buckets = new Map();

  function sweep(now) {
    for (const [key, bucket] of buckets.entries()) {
      const expired = bucket.windowEndsAt <= now && bucket.blockedUntil <= now;
      if (expired) {
        buckets.delete(key);
      }
    }
    while (buckets.size > maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      buckets.delete(oldestKey);
    }
  }

  function consume(key, { limit, windowMs, blockMs = windowMs }) {
    const now = Date.now();
    sweep(now);
    const bucket = buckets.get(key) || { count: 0, windowEndsAt: now + windowMs, blockedUntil: 0 };
    if (bucket.blockedUntil > now) {
      return { allowed: false, retryAfter: Math.ceil((bucket.blockedUntil - now) / 1000) };
    }
    if (bucket.windowEndsAt <= now) {
      bucket.count = 0;
      bucket.windowEndsAt = now + windowMs;
      bucket.blockedUntil = 0;
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      bucket.blockedUntil = now + blockMs;
      buckets.set(key, bucket);
      return { allowed: false, retryAfter: Math.ceil(blockMs / 1000) };
    }
    buckets.set(key, bucket);
    return { allowed: true, retryAfter: 0 };
  }

  return { consume };
}

export function consumeBrowserTokenRequest(rateLimiter, token, { limit, windowMs }) {
  if (!rateLimiter || !token) {
    return { allowed: true, retryAfter: 0 };
  }
  return rateLimiter.consume(browserTokenRequestLimitKey(token), {
    limit,
    windowMs
  });
}
