import { useEffect, useRef } from 'react';
import { readStoredValue, writeStoredValue } from './api.js';
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
import { useMessageSpeech } from './hooks/useMessageSpeech.js';
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
  const menuButtonRef = useRef(null);
  const wasDrawerOpenRef = useRef(false);
  const {
    status, authenticated, drawerOpen, setDrawerOpen, projects, selectedProject,
    expandedProjectIds, hiddenProjectIds, sessionsByProject, loadingProjectId, selectedSession,
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
    handleHideProject, handleSelectSession, handleRenameSession, handleDeleteSession, handleNewConversation
  } = projectController;
  const messageSpeech = useMessageSpeech(selectedSession?.id);
  const { handleDeleteMessage, handleUploadFiles, handleRemoveAttachment } = useMessageActions(
    app,
    rememberRelayOperationLock,
    {
      onDeleteMessageConfirmed: (message) => {
        const messageId = String(message?.id || '');
        if (
          messageId &&
          (messageSpeech.speakingMessageId === messageId || messageSpeech.speechLoadingMessageId === messageId)
        ) {
          messageSpeech.stopSpeech();
        }
      }
    }
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
    submitCodexMessage,
    onStopMessageSpeech: messageSpeech.stopSpeech
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
    app.hiddenProjectIdsRef.current = hiddenProjectIds;
  }, [app.hiddenProjectIdsRef, hiddenProjectIds]);


  useEffect(() => {
    writeStoredValue(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#171717' : '#f7f7f4');
  }, [theme]);

  useEffect(() => {
    if (selectedReasoningEffort) {
      writeStoredValue('codexmobile.reasoningEffort', selectedReasoningEffort);
    }
  }, [selectedReasoningEffort]);

  useEffect(() => {
    if (status.model && selectedModel === DEFAULT_STATUS.model) {
      setSelectedModel(status.model);
    }
  }, [selectedModel, status.model]);

  useEffect(() => {
    const saved = readStoredValue('codexmobile.reasoningEffort');
    if (!saved && status.reasoningEffort && !selectedReasoningEffort) {
      setSelectedReasoningEffort(status.reasoningEffort);
    }
  }, [selectedReasoningEffort, status.reasoningEffort]);

  const projectDisabledReason = selectedProject
    ? ''
    : syncing || !projects.length ? '正在同步项目...' : '未找到可用项目';
  const composerDisabledReason = relayDisabledReason(connectionState) || projectDisabledReason;
  const modalBackgroundInert = docsOpen || voiceDialog.open || Boolean(previewImage);
  const appContentInert = drawerOpen || modalBackgroundInert;

  useEffect(() => {
    let focusFrame = null;
    if (wasDrawerOpenRef.current && !drawerOpen && !modalBackgroundInert) {
      focusFrame = window.requestAnimationFrame(() => {
        menuButtonRef.current?.focus();
      });
    }
    wasDrawerOpenRef.current = drawerOpen;
    return () => {
      if (focusFrame !== null) {
        window.cancelAnimationFrame(focusFrame);
      }
    };
  }, [drawerOpen, modalBackgroundInert]);

  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} />;
  }

  const closeDrawer = () => {
    setDrawerOpen(false);
  };

  return (
    <div className="app-shell">
      <TopBar
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        connectionState={connectionState}
        onMenu={() => setDrawerOpen(true)}
        onOpenDocs={() => setDocsOpen(true)}
        backgroundInert={appContentInert}
        menuButtonRef={menuButtonRef}
      />
      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        projects={projects}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        expandedProjectIds={expandedProjectIds}
        sessionsByProject={sessionsByProject}
        loadingProjectId={loadingProjectId}
        onToggleProject={handleToggleProject}
        onHideProject={handleHideProject}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onNewConversation={handleNewConversation}
        onSync={handleSync}
        syncing={syncing}
        hiddenProjectIds={hiddenProjectIds}
        theme={theme}
        setTheme={setTheme}
        backgroundInert={modalBackgroundInert}
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
        onSpeakMessage={messageSpeech.speakMessage}
        speakingMessageId={messageSpeech.speakingMessageId}
        speechLoadingMessageId={messageSpeech.speechLoadingMessageId}
        backgroundInert={appContentInert}
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
        backgroundInert={appContentInert}
      />
      <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}
