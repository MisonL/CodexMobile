import { useEffect, useMemo, useState } from 'react';
import { rateLimitLockFromError, remainingLockSeconds } from '../api.js';
import { retryAfterLabel } from '../app-core-utils.js';

export function hasActiveRelayOperationLock(locks) {
  return Object.values(locks || {}).some((lock) => remainingLockSeconds(lock) > 0);
}

export function useRelayOperationLocks() {
  const [locks, setLocks] = useState({});
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!hasActiveRelayOperationLock(locks)) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!hasActiveRelayOperationLock(locks)) {
        window.clearInterval(timer);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [locks]);

  function rememberLock(scope, error) {
    const lock = rateLimitLockFromError(error, scope);
    if (!lock) {
      return false;
    }
    setLocks((current) => {
      if (current[scope]?.untilMs >= lock.untilMs) {
        return current;
      }
      return { ...current, [scope]: lock };
    });
    setNow(Date.now());
    return true;
  }

  const disabledReasons = useMemo(() => ({
    send: retryAfterLabel(locks.send, now),
    upload: retryAfterLabel(locks.upload, now),
    voice: retryAfterLabel(locks.voice, now),
    voiceDialog: retryAfterLabel(locks.voiceDialog, now)
  }), [locks, now]);

  return {
    rememberLock,
    disabledReasons
  };
}
