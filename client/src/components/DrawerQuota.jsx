import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { apiFetch } from '../api.js';
import { formatQuotaPercent, quotaRemainingPercent, quotaToneClass } from '../app-quota-utils.js';

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`invalid_quota_response:${fieldName}`);
  }
  return value;
}

function normalizeQuotaAccounts(result) {
  return requireArray(result?.accounts, 'accounts').map((account) => ({
    ...account,
    windows: requireArray(account?.windows, 'account.windows')
  }));
}

export function DrawerQuota() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);
  const [accounts, setAccounts] = useState([]);
  const mountedRef = useRef(true);
  const requestRef = useRef(null);
  const retryTimerRef = useRef(null);

  const clearRetryTimer = () => {
    if (retryTimerRef.current) {
      window.clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  const startRetryCooldown = (value) => {
    const seconds = Math.max(0, Math.ceil(Number(value || 0)));
    clearRetryTimer();
    setRetryAfter(seconds);
    if (!seconds) {
      return;
    }
    retryTimerRef.current = window.setInterval(() => {
      setRetryAfter((current) => {
        if (current <= 1) {
          clearRetryTimer();
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      clearRetryTimer();
    };
  }, []);

  const refresh = async (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    if (loading || retryAfter > 0) {
      return;
    }
    setExpanded(true);
    setLoading(true);
    setError('');
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const result = await apiFetch('/api/quotas/codex', { signal: controller.signal });
      if (!mountedRef.current || requestRef.current !== controller) {
        return;
      }
      startRetryCooldown(0);
      setAccounts(normalizeQuotaAccounts(result));
      setLoaded(true);
    } catch (error) {
      if (error.name === 'AbortError' || !mountedRef.current || requestRef.current !== controller) {
        return;
      }
      const retrySeconds = Number(error.retryAfter || 0);
      if (error.status === 429 || retrySeconds > 0) {
        startRetryCooldown(retrySeconds);
        setError(retrySeconds ? `请求过快，请 ${retrySeconds} 秒后重试` : '请求过快，请稍后重试');
      } else {
        setError('查询失败，点击刷新重试');
      }
      setLoaded(true);
    } finally {
      if (mountedRef.current && requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <div className={`quota-widget ${expanded ? 'is-expanded' : ''}`}>
      <div className="quota-row">
        <button type="button" className="quota-main" onClick={() => setExpanded((current) => !current)}>
          <span className="quota-title">额度查询</span>
          <span className="quota-kind">Codex</span>
        </button>
        <button type="button" className="quota-refresh" onClick={refresh} disabled={loading || retryAfter > 0}>
          {loading ? '刷新中...' : retryAfter > 0 ? `${retryAfter}s` : '刷新'}
        </button>
        <button
          type="button"
          className="quota-toggle"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? '收起额度查询' : '展开额度查询'}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {expanded ? (
        <div className="quota-panel">
          {error ? (
            <button type="button" className="quota-error" onClick={refresh} disabled={retryAfter > 0}>
              {error}
            </button>
          ) : null}
          {!error && accounts.length ? accounts.map((account) => (
            <QuotaAccount key={account.id} account={account} onRefresh={refresh} />
          )) : null}
          {!loading && !error && loaded && !accounts.length ? (
            <div className="quota-empty">暂无 Codex 凭证</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function QuotaAccount({ account, onRefresh }) {
  const windows = account.windows;
  const accountStatus = account.status || 'ok';
  const plan = account.plan || 'Codex';
  return (
    <div className={`quota-account is-${accountStatus}`}>
      <div className="quota-account-head">
        <span>{account.label || 'Codex'}</span>
        <small>{plan}</small>
      </div>
      {accountStatus === 'ok' && windows.length ? (
        <div className="quota-window-list">
          {windows.map((quotaWindow) => {
            const percent = quotaRemainingPercent(quotaWindow);
            return (
              <div key={quotaWindow.id} className={`quota-window ${quotaToneClass(percent)}`} style={{ '--quota-percent': `${percent ?? 0}%` }}>
                <div className="quota-window-meta">
                  <span>{quotaWindow.label}</span>
                  <strong>{formatQuotaPercent(quotaWindow)}</strong>
                </div>
                <div className="quota-bar">
                  <span />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <button type="button" className="quota-account-message" onClick={accountStatus === 'failed' ? onRefresh : undefined}>
          {accountStatus === 'disabled' ? '已停用' : '查询失败，点击刷新重试'}
        </button>
      )}
    </div>
  );
}
