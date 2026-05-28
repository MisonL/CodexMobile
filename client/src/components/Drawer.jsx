import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Folder, Loader2, MessageSquarePlus, Pencil, Settings, Trash2, X } from 'lucide-react';
import { compactPath, formatTime } from '../app-core-utils.js';
import { DrawerQuota } from './DrawerQuota.jsx';

// Keep longer than the .drawer transform transition so close animation can finish.
const DRAWER_UNMOUNT_DELAY_MS = 230;

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
  setTheme,
  backgroundInert = false
}) {
  const [drawerView, setDrawerView] = useState('main');
  const closeButtonRef = useRef(null);
  const [mounted, setMounted] = useState(open);

  const closeDrawer = () => {
    onClose();
  };

  const hiddenFromAssistive = backgroundInert || !open;
  const dialogProps = {
    role: 'dialog',
    'aria-modal': open && !backgroundInert ? true : undefined,
    'aria-label': '导航菜单',
    inert: hiddenFromAssistive ? '' : undefined
  };

  useEffect(() => {
    if (!open || backgroundInert) {
      return;
    }
    closeButtonRef.current?.focus();
  }, [backgroundInert, open]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setMounted(false);
      setDrawerView('main');
    }, DRAWER_UNMOUNT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) {
    return null;
  }

  if (drawerView === 'settings') {
    return (
      <>
        <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={closeDrawer} />
        <aside className={`drawer ${open ? 'is-open' : ''}`} {...dialogProps}>
          <div className="drawer-subheader">
            <button className="icon-button" onClick={() => setDrawerView('main')} aria-label="返回">
              <ChevronLeft size={22} />
            </button>
            <strong>设置</strong>
            <button ref={closeButtonRef} className="icon-button" onClick={closeDrawer} aria-label="关闭菜单">
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
      <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={closeDrawer} />
      <aside className={`drawer ${open ? 'is-open' : ''}`} {...dialogProps}>
        <div className="drawer-grip">
          <button ref={closeButtonRef} className="icon-button" onClick={closeDrawer} aria-label="关闭菜单">
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
                          加载中...
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
          <DrawerQuota />
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
