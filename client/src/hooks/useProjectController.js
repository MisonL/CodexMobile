import { useCallback } from 'react';
import { apiFetch, clearToken } from '../api.js';
import { authenticatedFromStatus, connectionStateFromStatus } from '../relay-status.js';
import { createDraftSession, isDraftSession, upsertSessionInProject } from '../app-core-utils.js';

export function useProjectController(app, runRegistry) {
  const loadStatus = useCallback(async () => {
    const data = await apiFetch('/api/status');
    app.setStatus(data);
    app.setAuthenticated(authenticatedFromStatus(data));
    app.setConnectionState(connectionStateFromStatus(data));
    runRegistry.syncActiveRunsFromStatus(data);
    return data;
  }, [app, runRegistry]);

  const loadSessions = useCallback(async (project, chooseLatest = true) => {
    if (!project) {
      app.setSelectedSession(null);
      app.setMessages([]);
      return;
    }
    app.setLoadingProjectId(project.id);
    try {
      const data = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`);
      const nextSessions = data.sessions || [];
      app.setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
      if (chooseLatest) {
        const next = nextSessions[0] || null;
        app.setSelectedSession(next);
        if (next) {
          const messageData = await apiFetch(`/api/sessions/${encodeURIComponent(next.id)}/messages?limit=120`);
          app.setMessages(messageData.messages || []);
        } else {
          app.setMessages([]);
        }
      } else {
        app.setSelectedSession(null);
        app.setMessages([]);
      }
    } finally {
      app.setLoadingProjectId((current) => (current === project.id ? null : current));
    }
  }, [app]);

  const loadProjects = useCallback(async () => {
    const data = await apiFetch('/api/projects');
    const list = data.projects || [];
    app.setProjects(list);
    const preferred =
      list.find((project) => project.name.toLowerCase() === 'codexmobile') ||
      list.find((project) => project.path.toLowerCase().includes('codexmobile')) ||
      list[0] ||
      null;
    app.setSelectedProject(preferred);
    if (preferred) {
      app.setExpandedProjectIds((current) => ({ ...current, [preferred.id]: true }));
    }
    await loadSessions(preferred);
  }, [app, loadSessions]);

  const bootstrap = useCallback(async () => {
    try {
      const currentStatus = await loadStatus();
      if (authenticatedFromStatus(currentStatus)) {
        await loadProjects();
        app.setSyncing(true);
        apiFetch('/api/sync', { method: 'POST' })
          .then(async () => {
            await loadStatus();
            await loadProjects();
          })
          .catch(() => null)
          .finally(() => app.setSyncing(false));
      }
    } catch (error) {
      if (String(error.message).includes('Pairing')) {
        clearToken();
        app.setAuthenticated(false);
      }
    }
  }, [app, loadProjects, loadStatus]);

  async function handleSync() {
    app.setSyncing(true);
    try {
      await apiFetch('/api/sync', { method: 'POST' });
      await loadStatus();
      await loadProjects();
    } finally {
      app.setSyncing(false);
    }
  }

  async function handleToggleProject(project) {
    const isExpanded = Boolean(app.expandedProjectIds[project.id]);
    if (isExpanded) {
      app.setExpandedProjectIds((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      return;
    }

    app.setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    const projectChanged = app.selectedProject?.id !== project.id;
    app.setSelectedProject(project);
    if (projectChanged) {
      app.setSelectedSession(null);
      app.setMessages([]);
    }
    if (!app.sessionsByProject[project.id]) {
      await loadSessions(project, false);
    }
  }

  async function handleSelectSession(session) {
    app.setSelectedSession(session);
    if (isDraftSession(session)) {
      app.setMessages([]);
      app.setDrawerOpen(false);
      return;
    }
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/messages?limit=120`);
    app.setMessages(data.messages || []);
    app.setDrawerOpen(false);
  }

  async function refreshProjectSessions(project) {
    if (!project?.id) {
      return;
    }
    const [projectData, sessionData] = await Promise.all([
      apiFetch('/api/projects'),
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
    ]);
    const nextProjects = projectData.projects || [];
    app.setProjects(nextProjects);
    app.setSessionsByProject((current) => ({ ...current, [project.id]: sessionData.sessions || [] }));
    const nextSelectedProject = nextProjects.find((item) => item.id === app.selectedProjectRef.current?.id);
    if (nextSelectedProject) {
      app.setSelectedProject(nextSelectedProject);
    }
  }

  async function handleRenameSession(project, session) {
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
  }

  async function handleDeleteSession(project, session) {
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
        app.setMessages([]);
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
  }

  function handleNewConversation() {
    const project = app.selectedProject || app.projects[0];
    if (!project) {
      return;
    }
    const draft = createDraftSession(project);
    app.setSelectedProject(project);
    app.setSelectedSession(draft);
    app.setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    app.setSessionsByProject((current) => upsertSessionInProject(current, project.id, draft));
    app.setMessages([]);
    app.setAttachments([]);
    app.setDrawerOpen(false);
  }

  return {
    loadStatus,
    loadProjects,
    bootstrap,
    handleSync,
    handleToggleProject,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleNewConversation
  };
}
