import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Folder, Loader2, MessageSquarePlus, Pencil, Settings, Trash2, X } from 'lucide-react';
import { apiFetch } from '../api.js';
import { compactPath, formatTime } from '../app-core-utils.js';
import { formatQuotaPercent, quotaRemainingPercent, quotaToneClass } from '../app-quota-utils.js';

export function Drawer({
  open,
  onClose,
  projects,
  selectedProject,
  selectedSession,
  expandedProjectIds,
  sessionsByProject,
  loadingProjectId,
  onToggleProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onNewConversation,
  onSync,
  syncing,
  theme,
  setTheme
}) {
  const [drawerView, setDrawerView] = useState('main');
  const [quotaExpanded, setQuotaExpanded] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [quotaAccounts, setQuotaAccounts] = useState([]);

  async function refreshCodexQuota(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (quotaLoading) {
      return;
    }
    setQuotaExpanded(true);
    setQuotaLoading(true);
    setQuotaError('');
    try {
      const result = await apiFetch('/api/quotas/codex');
      setQuotaAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setQuotaLoaded(true);
    } catch {
      setQuotaError('查询失败，点击刷新重试');
      setQuotaLoaded(true);
    } finally {
      setQuotaLoading(false);
    }
  }

  if (drawerView === 'settings') {
    return (
      <>
        <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
        <aside className={`drawer ${open ? 'is-open' : ''}`}>
          <div className="drawer-subheader">
            <button className="icon-button" onClick={() => setDrawerView('main')} aria-label="返回">
              <ChevronLeft size={22} />
            </button>
            <strong>设置</strong>
            <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
              <X size={20} />
            </button>
          </div>
          <div className="settings-view">
            <section className="settings-group">
              <div className="drawer-heading">外观</div>
              <div className="theme-setting">
                <div className="theme-setting-title">
                  <span>主题选择</span>
                </div>
                <div className="theme-segment" role="group" aria-label="主题选择">
                  <button
                    type="button"
                    className={theme === 'light' ? 'is-selected' : ''}
                    onClick={() => setTheme('light')}
                  >
                    白色
                  </button>
                  <button
                    type="button"
                    className={theme === 'dark' ? 'is-selected' : ''}
                    onClick={() => setTheme('dark')}
                  >
                    黑色
                  </button>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`}>
        <div className="drawer-grip">
          <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
            <X size={20} />
          </button>
        </div>

        <button className="drawer-action" onClick={onNewConversation}>
          <MessageSquarePlus size={20} />
          <span>
            <strong>新对话</strong>
            <small>在当前项目中新建</small>
          </span>
        </button>

        <section className="drawer-section project-section">
          <div className="drawer-heading">项目</div>
          <div className="project-list">
            {projects.map((project) => {
              const isSelected = selectedProject?.id === project.id;
              const isExpanded = Boolean(expandedProjectIds[project.id]);
              const projectSessions = sessionsByProject[project.id] || [];
              return (
                <div key={project.id} className="project-group">
                  <button
                    className={`project-row ${isSelected ? 'is-selected' : ''} ${isExpanded ? 'is-expanded' : ''}`}
                    onClick={() => onToggleProject(project)}
                  >
                    <Folder size={18} />
                    <span>
                      <strong>{project.name}</strong>
                      <small>{compactPath(project.path)}</small>
                    </span>
                    <small className="project-count">{project.sessionCount || projectSessions.length || 0}</small>
                    <ChevronDown size={15} className="project-chevron" />
                  </button>
                  {isExpanded ? (
                    <div className="thread-list">
                      {loadingProjectId === project.id ? (
                        <div className="thread-empty">
                          <Loader2 className="spin" size={14} />
                          加载中
                        </div>
                      ) : projectSessions.length ? (
                        projectSessions.map((session) => (
                          <div
                            key={session.id}
                            className={`thread-row ${selectedSession?.id === session.id ? 'is-selected' : ''} ${session.draft ? 'is-draft' : ''}`}
                          >
                            <button
                              type="button"
                              className="thread-main"
                              onClick={() => onSelectSession(session)}
                            >
                              <span>{session.title || '对话'}</span>
                              <small>{session.draft ? '待发送' : formatTime(session.updatedAt)}</small>
                            </button>
                            <button
                              type="button"
                              className="thread-rename"
                              onClick={() => onRenameSession(project, session)}
                              aria-label="重命名线程"
                              title="重命名线程"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="thread-delete"
                              onClick={() => onDeleteSession(project, session)}
                              aria-label="删除线程"
                              title="删除线程"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="thread-empty">暂无线程</div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="drawer-section drawer-controls">
          <div className="control-row sync-row">
            <span>
              对话同步
            </span>
            <button className="sync-button" onClick={onSync} disabled={syncing}>
              {syncing ? <Loader2 className="spin" size={16} /> : null}
              同步
            </button>
            <span className="sync-spacer" aria-hidden="true" />
          </div>
          <div className={`quota-widget ${quotaExpanded ? 'is-expanded' : ''}`}>
            <div className="quota-row">
              <button
                type="button"
                className="quota-main"
                onClick={() => setQuotaExpanded((current) => !current)}
              >
                <span className="quota-title">额度查询</span>
                <span className="quota-kind">Codex</span>
              </button>
              <button
                type="button"
                className="quota-refresh"
                onClick={refreshCodexQuota}
                disabled={quotaLoading}
              >
                {quotaLoading ? '刷新中...' : '刷新'}
              </button>
              <button
                type="button"
                className="quota-toggle"
                onClick={() => setQuotaExpanded((current) => !current)}
                aria-label={quotaExpanded ? '收起额度查询' : '展开额度查询'}
              >
                <ChevronDown size={16} />
              </button>
            </div>
            {quotaExpanded ? (
              <div className="quota-panel">
                {quotaError ? (
                  <button type="button" className="quota-error" onClick={refreshCodexQuota}>
                    {quotaError}
                  </button>
                ) : null}
                {!quotaError && quotaAccounts.length ? (
                  quotaAccounts.map((account) => {
                    const windows = Array.isArray(account.windows) ? account.windows : [];
                    const accountStatus = account.status || 'ok';
                    const plan = account.plan || 'Codex';
                    return (
                      <div key={account.id} className={`quota-account is-${accountStatus}`}>
                        <div className="quota-account-head">
                          <span>{account.label || 'Codex'}</span>
                          <small>{plan}</small>
                        </div>
                        {accountStatus === 'ok' && windows.length ? (
                          <div className="quota-window-list">
                            {windows.map((quotaWindow) => {
                              const percent = quotaRemainingPercent(quotaWindow);
                              return (
                                <div
                                  key={quotaWindow.id}
                                  className={`quota-window ${quotaToneClass(percent)}`}
                                  style={{ '--quota-percent': `${percent ?? 0}%` }}
                                >
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
                          <button
                            type="button"
                            className="quota-account-message"
                            onClick={accountStatus === 'failed' ? refreshCodexQuota : undefined}
                          >
                            {accountStatus === 'disabled' ? '已停用' : '查询失败，点击刷新重试'}
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : null}
                {!quotaLoading && !quotaError && quotaLoaded && !quotaAccounts.length ? (
                  <div className="quota-empty">暂无 Codex 凭证</div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button type="button" className="settings-entry" onClick={() => setDrawerView('settings')}>
            <span>
              <Settings size={18} />
              设置
            </span>
            <ChevronRight size={17} />
          </button>
        </section>
      </aside>
    </>
  );
}
