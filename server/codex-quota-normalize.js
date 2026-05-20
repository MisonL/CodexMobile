import crypto from 'node:crypto';

export function maskAccount(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'Codex';
  }
  const emailMatch = text.match(/^(.)([^@]*)(@.+)$/);
  if (emailMatch) {
    return `${emailMatch[1]}***${emailMatch[3]}`;
  }
  if (text.length <= 6) {
    return `${text.slice(0, 1)}***`;
  }
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

export function safeId(...values) {
  const source = values.find((value) => value) || crypto.randomUUID();
  return crypto.createHash('sha256').update(String(source)).digest('hex').slice(0, 16);
}

export function normalizePlan(value, fallback = '') {
  const text = String(value || fallback || '').trim().toLowerCase();
  if (!text) {
    return '';
  }
  if (text.includes('team')) {
    return 'Team';
  }
  if (text.includes('plus')) {
    return 'Plus';
  }
  if (text.includes('prolite') || text.includes('pro_lite') || text.includes('pro 5')) {
    return 'Pro 5x';
  }
  if (text.includes('pro')) {
    return 'Pro 20x';
  }
  if (text.includes('free')) {
    return 'Free';
  }
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

export function planFromFileName(fileName) {
  const match = String(fileName || '').match(/-([A-Za-z0-9_]+)\.json$/);
  return match ? match[1] : '';
}

export function authEntryName(entry) {
  return String(entry?.name || entry?.fileName || entry?.id || '').trim();
}

export function authEntryAccountId(entry) {
  return String(
    entry?.id_token?.chatgpt_account_id ||
    entry?.id_token?.chatgptAccountId ||
    entry?.metadata?.id_token?.chatgpt_account_id ||
    entry?.metadata?.id_token?.chatgptAccountId ||
    entry?.account_id ||
    entry?.accountId ||
    ''
  ).trim();
}

export function authEntryPlan(entry) {
  return (
    entry?.plan_type ||
    entry?.planType ||
    entry?.id_token?.plan_type ||
    entry?.id_token?.planType ||
    entry?.metadata?.id_token?.plan_type ||
    entry?.metadata?.id_token?.planType ||
    planFromFileName(authEntryName(entry))
  );
}

export function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizePercent(value, limitReached, allowed) {
  const parsed = numberOrNull(value);
  if (parsed !== null) {
    return Math.max(0, Math.min(100, parsed));
  }
  if (limitReached || allowed === false) {
    return 100;
  }
  return null;
}

export function windowSeconds(window) {
  return numberOrNull(window?.limit_window_seconds ?? window?.limitWindowSeconds);
}

export function slugLabel(value, fallback) {
  const text = String(value || fallback || '').trim();
  if (!text) {
    return 'additional';
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'additional';
}

export function resetLabel(window) {
  const value =
    window?.reset_after_seconds ??
    window?.resetAfterSeconds ??
    window?.reset_in ??
    window?.resetIn ??
    window?.ttl;
  const seconds = numberOrNull(value);
  if (!seconds || seconds <= 0) {
    return '';
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

export function selectPrimaryWindows(rateLimit) {
  const primary = rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? null;
  const secondary = rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? null;
  const candidates = [primary, secondary].filter(Boolean);
  let fiveHourWindow = null;
  let weeklyWindow = null;

  for (const candidate of candidates) {
    const seconds = windowSeconds(candidate);
    if (seconds === 18_000 && !fiveHourWindow) {
      fiveHourWindow = candidate;
    } else if (seconds === 604_800 && !weeklyWindow) {
      weeklyWindow = candidate;
    }
  }

  if (!fiveHourWindow && primary !== weeklyWindow) {
    fiveHourWindow = primary;
  }
  if (!weeklyWindow && secondary !== fiveHourWindow) {
    weeklyWindow = secondary;
  }

  return { fiveHourWindow, weeklyWindow };
}

export function quotaWindow(id, label, window, rateLimit) {
  if (!window) {
    return null;
  }
  const usedPercent = normalizePercent(
    window.used_percent ?? window.usedPercent,
    rateLimit?.limit_reached ?? rateLimit?.limitReached,
    rateLimit?.allowed
  );
  return {
    id,
    label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    displayPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    resetLabel: resetLabel(window)
  };
}

export function extractWindows(payload) {
  const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? null;
  if (!rateLimit) {
    return [];
  }
  const { fiveHourWindow, weeklyWindow } = selectPrimaryWindows(rateLimit);
  return [
    quotaWindow('five-hour', '5 小时限额', fiveHourWindow, rateLimit),
    quotaWindow('weekly', '周限额', weeklyWindow, rateLimit)
  ].filter(Boolean);
}

export function quotaWindowsForRateLimit(rateLimit, labels) {
  if (!rateLimit) {
    return [];
  }
  const { fiveHourWindow, weeklyWindow } = selectPrimaryWindows(rateLimit);
  return [
    quotaWindow(labels.fiveHourId, labels.fiveHourLabel, fiveHourWindow, rateLimit),
    quotaWindow(labels.weeklyId, labels.weeklyLabel, weeklyWindow, rateLimit)
  ].filter(Boolean);
}

export function additionalQuotaWindows(payload) {
  const limits = payload?.additional_rate_limits ?? payload?.additionalRateLimits;
  if (!Array.isArray(limits)) {
    return [];
  }
  return limits.flatMap((entry, index) => {
    const rateLimit = entry?.rate_limit ?? entry?.rateLimit ?? null;
    if (!rateLimit) {
      return [];
    }
    const rawName =
      entry?.limit_name ??
      entry?.limitName ??
      entry?.metered_feature ??
      entry?.meteredFeature ??
      `additional-${index + 1}`;
    const name = String(rawName || `additional-${index + 1}`).trim() || `additional-${index + 1}`;
    const slug = slugLabel(name, `additional-${index + 1}`);
    const primary = rateLimit.primary_window ?? rateLimit.primaryWindow ?? null;
    const secondary = rateLimit.secondary_window ?? rateLimit.secondaryWindow ?? null;
    return [
      quotaWindow(`${slug}-five-hour-${index}`, `${name} 5 小时限额`, primary, rateLimit),
      quotaWindow(`${slug}-weekly-${index}`, `${name} 周限额`, secondary, rateLimit)
    ].filter(Boolean);
  });
}

export function extractQuotaWindows(payload) {
  const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? null;
  const codeReviewRateLimit = payload?.code_review_rate_limit ?? payload?.codeReviewRateLimit ?? null;
  return [
    ...quotaWindowsForRateLimit(rateLimit, {
      fiveHourId: 'five-hour',
      fiveHourLabel: '5 小时限额',
      weeklyId: 'weekly',
      weeklyLabel: '周限额'
    }),
    ...quotaWindowsForRateLimit(codeReviewRateLimit, {
      fiveHourId: 'code-review-five-hour',
      fiveHourLabel: '代码审查 5 小时限额',
      weeklyId: 'code-review-weekly',
      weeklyLabel: '代码审查周限额'
    }),
    ...additionalQuotaWindows(payload)
  ];
}
