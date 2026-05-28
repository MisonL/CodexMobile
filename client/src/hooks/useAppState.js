import { useRef, useState } from 'react';
import { getToken } from '../api.js';
import { DEFAULT_STATUS } from '../relay-status.js';
import { DEFAULT_REASONING_EFFORT, REASONING_DEFAULT_VERSION, THEME_KEY } from '../app-core-utils.js';

export function useAppState() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [hiddenProjectIds, setHiddenProjectIds] = useState(() => new Set());
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [loadingProjectId, setLoadingProjectId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [previewImage, setPreviewImage] = useState(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsError, setDocsError] = useState('');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [permissionMode, setPermissionMode] = useState('default');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_STATUS.model);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(() => {
    const defaultVersion = localStorage.getItem('codexmobile.reasoningDefaultVersion');
    if (defaultVersion !== REASONING_DEFAULT_VERSION) {
      localStorage.setItem('codexmobile.reasoningDefaultVersion', REASONING_DEFAULT_VERSION);
      localStorage.setItem('codexmobile.reasoningEffort', DEFAULT_REASONING_EFFORT);
      return DEFAULT_REASONING_EFFORT;
    }
    return localStorage.getItem('codexmobile.reasoningEffort') || DEFAULT_REASONING_EFFORT;
  });
  const [runningById, setRunningById] = useState({});
  const [theme, setTheme] = useState(() =>
    localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  );
  const [syncing, setSyncing] = useState(false);
  const [connectionState, setConnectionState] = useState(() => (getToken() ? 'connecting' : 'disconnected'));
  const wsRef = useRef(null);
  const selectedProjectRef = useRef(null);
  const selectedSessionRef = useRef(null);
  const hiddenProjectIdsRef = useRef(new Set());
  const runningByIdRef = useRef({});
  const lastLocalRunAtRef = useRef(0);
  const activePollsRef = useRef(new Set());
  const turnRefreshTimersRef = useRef(new Map());

  return {
    status, setStatus, authenticated, setAuthenticated, drawerOpen, setDrawerOpen,
    projects, setProjects, selectedProject, setSelectedProject, expandedProjectIds,
    setExpandedProjectIds, hiddenProjectIds, setHiddenProjectIds, sessionsByProject,
    setSessionsByProject, loadingProjectId, setLoadingProjectId, selectedSession, setSelectedSession, messages, setMessages,
    previewImage, setPreviewImage, docsOpen, setDocsOpen, docsBusy, setDocsBusy,
    docsError, setDocsError, input, setInput, attachments, setAttachments, uploading,
    setUploading, permissionMode, setPermissionMode, selectedModel, setSelectedModel,
    selectedReasoningEffort, setSelectedReasoningEffort, runningById, setRunningById,
    theme, setTheme, syncing, setSyncing, connectionState, setConnectionState, wsRef,
    selectedProjectRef, selectedSessionRef, hiddenProjectIdsRef, runningByIdRef,
    lastLocalRunAtRef, activePollsRef, turnRefreshTimersRef
  };
}
