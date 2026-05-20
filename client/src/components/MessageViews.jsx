import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { copyTextToClipboard, formatTime, imageUrlWithRetry } from '../app-core-utils.js';
import { isVisibleActivityStep } from '../app-message-state.js';

export function ActivityMessage({ message }) {
  const running = message.status === 'running' || message.status === 'queued';
  const failed = message.status === 'failed';
  const activities = message.activities || [];
  const visibleSteps = activities.filter((activity) => isVisibleActivityStep(activity, message.status)).slice(-4);
  const headline = running ? '正在思考中' : message.label || message.content || '正在处理';

  return (
    <div className="message-row is-activity">
      <div className={`message-bubble activity-bubble ${failed ? 'is-failed' : ''}`}>
        <div className="activity-summary" role="status" aria-live="polite">
          {running ? <Loader2 className="spin" size={15} /> : failed ? <X size={15} /> : <Check size={15} />}
          <span>{headline}</span>
        </div>
        {visibleSteps.length ? (
          <div className="activity-steps" aria-label="任务进度">
            {visibleSteps.map((activity) => (
              <div key={activity.id} className={`activity-step is-${activity.status || 'running'}`}>
                <span className="activity-step-dot" />
                <span>{activity.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {message.timestamp ? <time>{formatTime(message.timestamp)}</time> : null}
      </div>
    </div>
  );
}

export function GeneratedImage({ part, onPreviewImage }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);
  const src = imageUrlWithRetry(part.url, retryKey);

  function retry(event) {
    event.stopPropagation();
    setLoadState('loading');
    setRetryKey(Date.now());
  }

  return (
    <button
      type="button"
      className={`message-image-link ${loadState === 'failed' ? 'is-failed' : ''}`}
      onClick={() => (loadState === 'failed' ? setRetryKey(Date.now()) : onPreviewImage(part))}
      aria-label="预览图片"
    >
      <img
        className="message-image"
        src={src}
        alt={part.alt}
        loading="eager"
        decoding="async"
        onLoad={() => setLoadState('loaded')}
        onError={() => setLoadState('failed')}
      />
      {loadState === 'failed' ? (
        <span className="image-error">
          图片加载失败
          <span onClick={retry}>重试</span>
        </span>
      ) : null}
    </button>
  );
}

export function ImagePreviewModal({ image, onClose }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setLoadState('loading');
    setRetryKey(0);
  }, [image?.url]);

  if (!image) {
    return null;
  }

  const src = imageUrlWithRetry(image.url, retryKey);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-top">
        <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭图片预览">
          <X size={22} />
        </button>
      </div>
      <div className="lightbox-stage" onClick={(event) => event.stopPropagation()}>
        <img
          src={src}
          alt={image.alt || '生成图片'}
          onLoad={() => setLoadState('loaded')}
          onError={() => setLoadState('failed')}
        />
      </div>
      {loadState === 'failed' ? (
        <div className="lightbox-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            onClick={() => {
              setLoadState('loading');
              setRetryKey(Date.now());
            }}
          >
            <RefreshCw size={16} />
            重新加载
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MessageContent({ content, onPreviewImage }) {
  const text = String(content || '');
  const parts = [];
  const pattern = /!\[([^\]]*)\]\((\/generated\/[^)\s]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'image', alt: match[1] || '生成图片', url: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  if (!parts.length) {
    return <div className="message-content">{renderInlineText(text, 'message-root')}</div>;
  }

  const rendered = [];
  parts.forEach((part, index) => {
    if (part.type === 'image') {
      rendered.push(<GeneratedImage key={`${part.url}-${index}`} part={part} onPreviewImage={onPreviewImage} />);
      return;
    }
    rendered.push(...renderInlineText(part.value, `message-${index}`));
  });

  return (
    <div className="message-content">
      {rendered}
    </div>
  );
}

export function normalizeInlineHref(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) {
    return raw;
  }
  return `https://${raw}`;
}

export function renderInlineText(text, keyPrefix) {
  const value = String(text || '');
  const pattern = /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)|((?:https?:\/\/|www\.)[^\s<>()]+)/gi;
  const nodes = [];
  let lastIndex = 0;
  let match;
  let partIndex = 0;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex, match.index)}</span>);
    }

    if (match[1] && match[2]) {
      const href = normalizeInlineHref(match[2]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[1]}
        </a>
      );
    } else if (match[3]) {
      const href = normalizeInlineHref(match[3]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[3]}
        </a>
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < value.length) {
    nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex)}</span>);
  }

  return nodes.length ? nodes : [<span key={`${keyPrefix}-text-0`}>{value}</span>];
}

export function ChatMessage({ message, onPreviewImage, onDeleteMessage }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  if (message.role === 'activity') {
    return <ActivityMessage message={message} />;
  }
  const isUser = message.role === 'user';
  const canAct = message.role === 'user' || message.role === 'assistant';

  async function handleCopy() {
    const copiedText = await copyTextToClipboard(message.content);
    if (!copiedText) {
      window.alert('复制失败');
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={`message-row ${isUser ? 'is-user' : ''}`}>
      <div className="message-stack">
        <div className="message-bubble">
          <MessageContent content={message.content} onPreviewImage={onPreviewImage} />
          {message.timestamp ? <time>{formatTime(message.timestamp)}</time> : null}
        </div>
        {canAct ? (
          <div className="message-actions" aria-label="消息操作">
            <button type="button" className="message-action" onClick={handleCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <button type="button" className="message-action is-delete" onClick={() => onDeleteMessage?.(message)}>
              <Trash2 size={13} />
              <span>删除</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPane({ messages, selectedSession, running, onPreviewImage, onDeleteMessage }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, running]);

  if (!messages.length) {
    return (
      <section className="chat-pane empty-chat">
        <div className="empty-orbit">
          <ShieldCheck size={30} />
        </div>
        <h2>{selectedSession ? selectedSession.title : '新对话'}</h2>
        <p>问 Codex 任何事。</p>
      </section>
    );
  }

  return (
    <section className="chat-pane">
      {messages.map((message) => (
        <ChatMessage
          key={message.id}
          message={message}
          onPreviewImage={onPreviewImage}
          onDeleteMessage={onDeleteMessage}
        />
      ))}
      <div ref={bottomRef} />
    </section>
  );
}
