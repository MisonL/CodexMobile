import { apiFetch } from '../api.js';
import { createDraftSession, isDraftSession, upsertSessionInProject } from '../app-core-utils.js';

export function createProjectSessionActions({ app, clearSelectedMessages, refreshProjectSessions, blurActiveElement }) {
  const handleRenameSession = async (project, session) => {
    if (!project?.id || !session?.id) {
      return;
    }
    const currentTitle = session.title || '对话';
    const nextTitle = window.prompt('重命名线程', currentTitle)?.trim().slice(0, 52);
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }
    const applyLocalTitle = () => {
      app.setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === session.id ? { ...item, title: nextTitle, titleLocked: true } : item
        )
      }));
      if (app.selectedSessionRef.current?.id === session.id) {
        app.setSelectedSession((current) => (current ? { ...current, title: nextTitle, titleLocked: true } : current));
      }
    };
    if (isDraftSession(session)) {
      applyLocalTitle();
      return;
    }
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: { title: nextTitle }
      });
      applyLocalTitle();
      await refreshProjectSessions(project);
    } catch (error) {
      window.alert(`重命名失败：${error.message}`);
    }
  };

  const handleDeleteSession = async (project, session) => {
    if (!project?.id || !session?.id) {
      return;
    }
    const title = session.title || '对话';
    const confirmed = window.confirm(`从 CodexMobile 隐藏线程“${title}”？不会影响 Codex App 的原始会话。`);
    if (!confirmed) {
      return;
    }
    const removeLocalSession = () => {
      app.setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).filter((item) => item.id !== session.id)
      }));
      if (app.selectedSessionRef.current?.id === session.id) {
        app.setSelectedSession(null);
        clearSelectedMessages();
        app.setAttachments([]);
        app.setInput('');
      }
    };
    if (isDraftSession(session)) {
      removeLocalSession();
      return;
    }
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE'
      });
      removeLocalSession();
      await refreshProjectSessions(project);
    } catch (error) {
      const message = String(error.message || '');
      window.alert(
        message.toLowerCase().includes('running') ? '线程正在运行，稍后再删除。' : `删除失败：${message}`
      );
    }
  };

  const handleNewConversation = () => {
    const project = app.selectedProject || app.projects[0];
    if (!project) {
      return;
    }
    blurActiveElement();
    const draft = createDraftSession(project);
    app.setSelectedProject(project);
    app.setSelectedSession(draft);
    app.setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    app.setSessionsByProject((current) => upsertSessionInProject(current, project.id, draft));
    clearSelectedMessages();
    app.setAttachments([]);
    app.setDrawerOpen(false);
  };

  return {
    handleRenameSession,
    handleDeleteSession,
    handleNewConversation
  };
}
