import { useEffect, useMemo } from 'react';
import { DEFAULT_STATUS, relayDisabledReason } from './relay-status.js';
import { PairingScreen } from './PairingScreen.jsx';
import { TopBar } from './TopBar.jsx';
import { THEME_KEY } from './app-core-utils.js';
import { useAppWebSocket } from './hooks/useAppWebSocket.js';
import { useAppState } from './hooks/useAppState.js';
import { useChatActions } from './hooks/useChatActions.js';
import { useDocsActions } from './hooks/useDocsActions.js';
import { useMessageActions } from './hooks/useMessageActions.js';
import { useProjectController } from './hooks/useProjectController.js';
import { useRelayOperationLocks } from './hooks/useRelayOperationLocks.js';
import { useRunRegistry } from './hooks/useRunRegistry.js';
import { useTurnPolling } from './hooks/useTurnPolling.js';
import { useTurnRefresh } from './hooks/useTurnRefresh.js';
import { useViewportMetrics } from './hooks/useViewportMetrics.js';
import { useVoiceDialogController } from './hooks/useVoiceDialogController.js';
import { Drawer } from './components/Drawer.jsx';
import { DocsPanel } from './components/DocsPanel.jsx';
import { ChatPane, ImagePreviewModal } from './components/MessageViews.jsx';
import { VoiceDialogPanel } from './components/VoiceDialogPanel.jsx';
import { Composer } from './components/Composer.jsx';

export default function App() {
  const app = useAppState();
  const {
    status, authenticated, drawerOpen, setDrawerOpen, projects, selectedProject,
    expandedProjectIds, sessionsByProject, loadingProjectId, selectedSession,
    messages, previewImage, setPreviewImage, docsOpen, setDocsOpen, docsBusy,
    docsError, input, setInput, attachments, uploading, permissionMode,
    setPermissionMode, selectedModel, setSelectedModel, selectedReasoningEffort,
    setSelectedReasoningEffort, runningById, theme, setTheme, syncing,
    connectionState, selectedProjectRef, selectedSessionRef
  } = app;
  useViewportMetrics();
  const {
    rememberLock: rememberRelayOperationLock,
    disabledReasons: actionDisabledReasons
  } = useRelayOperationLocks();

  const runRegistry = useRunRegistry(app);
  const { running } = runRegistry;
  const turnRefresh = useTurnRefresh(app, runRegistry);
  const turnPolling = useTurnPolling(app, runRegistry, turnRefresh);
  const chatActions = useChatActions(app, runRegistry, turnPolling, rememberRelayOperationLock);
  const { submitCodexMessage, handleSubmit, handleVoiceSubmit, handleAbort } = chatActions;

  const projectController = useProjectController(app, runRegistry);
  const {
    loadStatus, bootstrap, handleSync, handleToggleProject,
    handleSelectSession, handleRenameSession, handleDeleteSession, handleNewConversation
  } = projectController;
  const { handleDeleteMessage, handleUploadFiles, handleRemoveAttachment } = useMessageActions(
    app,
    rememberRelayOperationLock
  );
  const {
    handleConnectDocs, handleDisconnectDocs, handleRefreshDocs,
    handleOpenDocsHome, handleOpenDocsAuth
  } = useDocsActions(app, loadStatus);

  const voiceDialog = useVoiceDialogController({
    status,
    selectedProject,
    selectedProjectRef,
    messages,
    runningById,
    rememberRelayOperationLock,
    onVoiceSubmit: handleVoiceSubmit,
    submitCodexMessage
  });
  useAppWebSocket(app, runRegistry, turnRefresh);

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);


  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (selectedReasoningEffort) {
      localStorage.setItem('codexmobile.reasoningEffort', selectedReasoningEffort);
    }
  }, [selectedReasoningEffort]);

  useEffect(() => {
    if (status.model && selectedModel === DEFAULT_STATUS.model) {
      setSelectedModel(status.model);
    }
  }, [selectedModel, status.model]);

  useEffect(() => {
    const saved = localStorage.getItem('codexmobile.reasoningEffort');
    if (!saved && status.reasoningEffort && !selectedReasoningEffort) {
      setSelectedReasoningEffort(status.reasoningEffort);
    }
  }, [selectedReasoningEffort, status.reasoningEffort]);

  const shellClass = useMemo(() => (drawerOpen ? 'app-shell drawer-active' : 'app-shell'), [drawerOpen]);
  const composerDisabledReason = relayDisabledReason(connectionState);
  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} />;
  }

  return (
    <div className={shellClass}>
      <TopBar
        selectedProject={selectedProject}
        connectionState={connectionState}
        onMenu={() => setDrawerOpen(true)}
        onOpenDocs={() => setDocsOpen(true)}
      />
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        projects={projects}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        expandedProjectIds={expandedProjectIds}
        sessionsByProject={sessionsByProject}
        loadingProjectId={loadingProjectId}
        onToggleProject={handleToggleProject}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onNewConversation={handleNewConversation}
        onSync={handleSync}
        syncing={syncing}
        theme={theme}
        setTheme={setTheme}
      />
      <DocsPanel
        open={docsOpen}
        docs={status.docs}
        busy={docsBusy}
        error={docsError}
        onClose={() => setDocsOpen(false)}
        onConnect={handleConnectDocs}
        onDisconnect={handleDisconnectDocs}
        onOpenHome={handleOpenDocsHome}
        onOpenAuth={handleOpenDocsAuth}
        onRefresh={handleRefreshDocs}
      />
      <ChatPane
        messages={messages}
        selectedSession={selectedSession}
        running={running}
        onPreviewImage={setPreviewImage}
        onDeleteMessage={handleDeleteMessage}
      />
      <VoiceDialogPanel
        open={voiceDialog.open}
        state={voiceDialog.state}
        error={voiceDialog.error}
        transcript={voiceDialog.transcript}
        assistantText={voiceDialog.assistantText}
        handoffDraft={voiceDialog.handoffDraft}
        onHandoffDraftChange={voiceDialog.setHandoffDraft}
        onHandoffSubmit={voiceDialog.submitHandoffToCodex}
        onHandoffContinue={voiceDialog.continueHandoffCollection}
        onHandoffCancel={voiceDialog.cancelHandoffConfirmation}
        onStart={voiceDialog.startRecording}
        onStop={voiceDialog.stopRecording}
        onClose={voiceDialog.closeDialog}
      />
      <Composer
        input={input}
        setInput={setInput}
        onSubmit={handleSubmit}
        running={running}
        onAbort={handleAbort}
        models={status.models}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        selectedReasoningEffort={selectedReasoningEffort}
        onSelectReasoningEffort={setSelectedReasoningEffort}
        permissionMode={permissionMode}
        onSelectPermission={setPermissionMode}
        attachments={attachments}
        onUploadFiles={handleUploadFiles}
        onRemoveAttachment={handleRemoveAttachment}
        onRateLimit={rememberRelayOperationLock}
        uploading={uploading}
        onVoiceSubmit={handleVoiceSubmit}
        onOpenVoiceDialog={voiceDialog.openDialog}
        voiceDialogActive={voiceDialog.open}
        disabled={Boolean(composerDisabledReason)}
        disabledReason={composerDisabledReason}
        actionDisabledReasons={actionDisabledReasons}
      />
      <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}
