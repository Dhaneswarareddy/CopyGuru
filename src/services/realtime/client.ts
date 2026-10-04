'use client';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ChatMessageView, NotificationView } from '@/lib/domain/views';
import { RT, type RealtimeSessionEvent } from '@/lib/realtime/gateway';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'removed';

interface Handlers {
  onSessionEvent(event: RealtimeSessionEvent): void;
  onNotification(notification: NotificationView): void;
  onChatMessage(message: ChatMessageView): void;
  /** Called after a dropped connection comes back: state may be stale. */
  onReconnect(): void;
}

/**
 * Keeps one Socket.IO connection per session token. Socket.IO retries with
 * backoff on its own; this hook just reports the state so the UI can show
 * "Reconnecting…" and re-sync once the link is back.
 */
export function useSessionSocket(token: string | null, handlers: Handlers): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!token) return;
    let hadConnection = false;
    const socket: Socket = io({ auth: { token }, reconnectionDelayMax: 5000 });
    socket.on('connect', () => {
      setState('connected');
      if (hadConnection) latest.current.onReconnect();
      hadConnection = true;
    });
    // once removed, stay removed: do not flip back to "reconnecting"
    socket.on('disconnect', () => setState((s) => (s === 'removed' ? s : 'reconnecting')));
    socket.on('connect_error', (err) =>
      setState(err.message === 'removed' ? 'removed' : err.message === 'unauthorized' ? 'unauthorized' : 'reconnecting'),
    );
    socket.on(RT.REMOVED, () => {
      setState('removed');
      socket.close();
    });
    socket.on(RT.SESSION_EVENT, (e: RealtimeSessionEvent) => latest.current.onSessionEvent(e));
    socket.on(RT.NOTIFICATION, (n: NotificationView) => latest.current.onNotification(n));
    socket.on(RT.CHAT_MESSAGE, (m: ChatMessageView) => latest.current.onChatMessage(m));
    return () => {
      socket.close();
    };
  }, [token]);

  return state;
}
