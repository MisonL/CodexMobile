import { useCallback, useRef } from 'react';
import { apiFetch, isPairingRequiredError } from '../api.js';
import { canUseAppShellFromStatus, connectionStateFromStatus } from '../relay-status.js';
import { isDraftSession } from '../app-core-utils.js';
import { createProjectSessionActions } from './project-session-actions.js';

function blurActiveElement() {
  if (typeof document.activeElement?.blur === 'function') {
    document.activeElement.blur();
  }
}

export function useProjectController(app, runRegistry) {
  const sessionLoadIdRef = useRef(0);

  const loadStatus = useCallback(async () => {
    const data = await apiFetch('/api/status');
    app.setStatus(data);
    app.setAuthenticated(canUseAppShellFromStatus(data));
    app.setConnectionState(connectionStateFromStatus(data));
    runRegistry.syncActiveRunsFromStatus(data);
    return data;
  }, [app, runRegistry]);

  const clearSelectedMessages = () => {
    sessionLoadIdRef.current += 1;
    app.setMessages([]);
  };

  const loadSessionMessages = async (session) => {
    if (!session?.id) {
      clearSelectedMessages();
      return false;
    }
    const loadId = ++sessionLoadIdRef.current;
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/messages?limit=120`);
    if (sessionLoadIdRef.current !== loadId) {
      return false;
    }
    app.setMessages(data.messages || []);
    return true;
  };

  const loadSessions = useCallback(async (project, chooseLatest = true) => {
    if (!project) {
      app.setSelectedSession(null);
      clearSelectedMessages();
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
          await loadSessionMessages(next);
        } else {
          clearSelectedMessages();
        }
      } else {
        app.setSelectedSession(null);
        clearSelectedMessages();
      }
    } finally {
      app.setLoadingProjectId((current) => (current === project.id ? null : current));
    }
  }, [app]);

  const loadProjects = useCallback(async () => {
    const data = await apiFetch('/api/projects');
    const list = data.projects || [];
    app.setProjects(list);
    const hiddenIds = app.hiddenProjectIdsRef.current;
    const visibleList = list.filter((project) => !hiddenIds.has(project.id));
    const currentSelected = app.selectedProjectRef.current;
    const preferred =
      visibleList.find((project) => project.id === currentSelected?.id) ||
      visibleList.find((project) => project.name.toLowerCase() === 'codexmobile') ||
      visibleList.find((project) => project.path.toLowerCase().includes('codexmobile')) ||
      visibleList[0] ||
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
      if (canUseAppShellFromStatus(currentStatus)) {
        await loadProjects();
        app.setSyncing(true);
        apiFetch('/api/sync', { method: 'POST' })
          .then(async () => {
            await loadStatus();
            const project = app.selectedProjectRef.current;
            if (project?.id) {
              await refreshProjectSessions(project);
            } else {
              await loadProjects();
            }
          })
          .catch(() => null)
          .finally(() => app.setSyncing(false));
      }
    } catch (error) {
      if (isPairingRequiredError(error)) {
        app.setAuthenticated(false);
        app.setConnectionState('pairing_required');
      }
    }
  }, [app, loadProjects, loadStatus]);

  const handleSync = async () => {
    app.setSyncing(true);
    try {
      await apiFetch('/api/sync', { method: 'POST' });
      const emptyHiddenProjectIds = new Set();
      app.hiddenProjectIdsRef.current = emptyHiddenProjectIds;
      app.setHiddenProjectIds(emptyHiddenProjectIds);
      await loadStatus();
      await loadProjects();
    } finally {
      app.setSyncing(false);
    }
  };

  const handleHideProject = async (project) => {
    if (!project?.id) {
      return;
    }
    const nextHiddenProjectIds = new Set(app.hiddenProjectIdsRef.current);
    nextHiddenProjectIds.add(project.id);
    app.hiddenProjectIdsRef.current = nextHiddenProjectIds;
    app.setHiddenProjectIds(nextHiddenProjectIds);
    app.setExpandedProjectIds((current) => {
      const next = { ...current };
      delete next[project.id];
      return next;
    });

    if (app.selectedProjectRef.current?.id !== project.id) {
      return;
    }

    const nextProject = app.projects.find((item) => item.id !== project.id && !nextHiddenProjectIds.has(item.id)) || null;
    app.selectedProjectRef.current = nextProject;
    app.selectedSessionRef.current = null;
    app.setSelectedProject(nextProject);
    app.setSelectedSession(null);
    clearSelectedMessages();
    app.setAttachments([]);
    app.setInput('');

    if (nextProject) {
      app.setExpandedProjectIds((current) => ({ ...current, [nextProject.id]: true }));
      await loadSessions(nextProject, true);
    }
  };

  const handleToggleProject = async (project) => {
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
      clearSelectedMessages();
    }
    if (!app.sessionsByProject[project.id]) {
      await loadSessions(project, false);
    }
  };

  const handleSelectSession = async (project, session) => {
    const nextProject =
      project ||
      app.projects.find((item) => item.id === session?.projectId) ||
      app.selectedProjectRef.current;
    blurActiveElement();
    if (nextProject?.id) {
      app.selectedProjectRef.current = nextProject;
      app.setSelectedProject(nextProject);
      app.setExpandedProjectIds((current) => ({ ...current, [nextProject.id]: true }));
    }
    app.selectedSessionRef.current = session;
    app.setSelectedSession(session);
    app.setAttachments([]);
    app.setInput('');
    if (isDraftSession(session)) {
      clearSelectedMessages();
      app.setDrawerOpen(false);
      return;
    }
    try {
      await loadSessionMessages(session);
    } catch (error) {
      console.warn(`[project] failed to load session messages session=${session.id}:`, error.message || error);
    } finally {
      app.setDrawerOpen(false);
    }
  };

  const refreshProjectSessions = async (project) => {
    if (!project?.id) {
      return;
    }
    const [projectData, sessionData] = await Promise.all([
      apiFetch('/api/projects'),
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
    ]);
    const nextProjects = projectData.projects || [];
    app.setProjects(nextProjects);
    const nextSessions = sessionData.sessions || [];
    app.setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
    const currentProjectId = app.selectedProjectRef.current?.id || app.selectedProject?.id;
    if (currentProjectId && currentProjectId !== project.id) {
      return;
    }
    const nextSelectedProject = nextProjects.find((item) => item.id === currentProjectId);
    if (nextSelectedProject) {
      app.setSelectedProject(nextSelectedProject);
    }
    if (!app.selectedSessionRef.current && nextSessions[0]) {
      const nextSession = nextSessions[0];
      app.setSelectedSession(nextSession);
      await loadSessionMessages(nextSession);
    }
  };

  const {
    handleRenameSession,
    handleDeleteSession,
    handleNewConversation
  } = createProjectSessionActions({ app, clearSelectedMessages, refreshProjectSessions, blurActiveElement });

  return {
    loadStatus,
    loadProjects,
    bootstrap,
    handleSync,
    handleToggleProject,
    handleHideProject,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleNewConversation
  };
}
