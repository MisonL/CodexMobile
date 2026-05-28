import { apiFetch } from '../api.js';
import { isDraftSession } from '../app-core-utils.js';

export function useMessageActions(app, rememberRelayOperationLock, { onDeleteMessageConfirmed } = {}) {
  const handleDeleteMessage = async (message) => {
    if (!message?.id) {
      return;
    }
    if (!window.confirm('删除这条消息？')) {
      return;
    }

    const messageId = String(message.id);
    const sessionId = app.selectedSessionRef.current?.id || message.sessionId || '';
    const existingIndex = app.messages.findIndex((item) => String(item.id) === messageId);
    const removedMessage = existingIndex >= 0 ? app.messages[existingIndex] : message;
    app.setMessages((current) => current.filter((item) => String(item.id) !== messageId));

    if (!sessionId || isDraftSession({ id: sessionId })) {
      onDeleteMessageConfirmed?.(removedMessage);
      return;
    }

    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
      onDeleteMessageConfirmed?.(removedMessage);
    } catch (error) {
      app.setMessages((current) => {
        if (current.some((item) => String(item.id) === messageId)) {
          return current;
        }
        const next = [...current];
        const insertAt = existingIndex >= 0 ? Math.min(existingIndex, next.length) : next.length;
        next.splice(insertAt, 0, removedMessage);
        return next;
      });
      window.alert(`删除失败：${error.message}`);
    }
  };

  const handleUploadFiles = async (files) => {
    app.setUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const result = await apiFetch('/api/uploads', {
          method: 'POST',
          body: formData
        });
        app.setAttachments((current) => [...current, result.upload]);
      }
    } catch (error) {
      rememberRelayOperationLock('upload', error);
      app.setMessages((current) => [
        ...current,
        {
          id: `upload-error-${Date.now()}`,
          role: 'activity',
          status: 'failed',
          label: '上传失败',
          detail: error.message,
          content: error.message,
          transient: true,
          timestamp: new Date().toISOString()
        }
      ]);
    } finally {
      app.setUploading(false);
    }
  };

  const handleRemoveAttachment = (id) => {
    app.setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  return {
    handleDeleteMessage,
    handleUploadFiles,
    handleRemoveAttachment
  };
}
