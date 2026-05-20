import { apiFetch } from '../api.js';

export function useDocsActions(app, loadStatus) {
  async function handleConnectDocs() {
    if (app.docsBusy) {
      return;
    }
    app.setDocsBusy(true);
    app.setDocsError('');
    try {
      const result = await apiFetch('/api/feishu/cli/auth/start', { method: 'POST' });
      if (result.docs) {
        app.setStatus((current) => ({ ...current, docs: result.docs }));
      }
      if (!result.verificationUrl) {
        throw new Error('没有收到飞书授权地址');
      }
      window.location.assign(result.verificationUrl);
    } catch (error) {
      app.setDocsError(error.message || '飞书连接失败');
      app.setDocsBusy(false);
    }
  }

  async function handleDisconnectDocs() {
    if (app.docsBusy) {
      return;
    }
    app.setDocsBusy(true);
    app.setDocsError('');
    try {
      await apiFetch('/api/feishu/cli/auth/logout', { method: 'POST' });
      await loadStatus();
    } catch (error) {
      app.setDocsError(error.message || '断开飞书失败');
    } finally {
      app.setDocsBusy(false);
    }
  }

  async function handleRefreshDocs() {
    if (app.docsBusy) {
      return;
    }
    app.setDocsBusy(true);
    app.setDocsError('');
    try {
      await loadStatus();
    } catch (error) {
      app.setDocsError(error.message || '刷新飞书状态失败');
    } finally {
      app.setDocsBusy(false);
    }
  }

  function handleOpenDocsHome() {
    const docsUrl = String(app.status.docs?.homeUrl || 'https://docs.feishu.cn/').trim();
    if (docsUrl) {
      window.location.assign(docsUrl);
    }
  }

  function handleOpenDocsAuth(url) {
    const authUrl = String(url || '').trim();
    if (authUrl) {
      window.location.assign(authUrl);
    }
  }

  return {
    handleConnectDocs,
    handleDisconnectDocs,
    handleRefreshDocs,
    handleOpenDocsHome,
    handleOpenDocsAuth
  };
}
