'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, type ApiOptions } from '@/lib/client/api';
import type { ChatMessageView, NotificationView, SessionStateView } from '@/lib/domain/views';
import type { RealtimeSessionEvent } from '@/lib/realtime/gateway';
import { useSessionSocket, type ConnectionState } from '@/services/realtime/client';

export type TabKey = 'play' | 'questions' | 'host';

interface SessionContextValue {
  code: string;
  /** The viewer's session token (for the rare request that cannot go through `call`). */
  token: string;
  state: SessionStateView;
  connection: ConnectionState;
  /** Authenticated API call. */
  call<T>(path: string, opts?: Omit<ApiOptions, 'token'>): Promise<T>;
  refresh(): Promise<void>;
  /** Subscribe to live session events; returns an unsubscribe function. */
  subscribe(listener: (event: RealtimeSessionEvent) => void): () => void;
  /** Subscribe to incoming chat messages (public, and private ones addressed to or sent by the viewer). */
  subscribeChat(listener: (message: ChatMessageView) => void): () => void;
  notifications: NotificationView[];
  unread: number;
  toasts: NotificationView[];
  dismissToast(id: string): void;
  markRead(ids: string[] | null): void;
  tab: TabKey;
  setTab(tab: TabKey): void;
  openQuestionId: string | null;
  openQuestion(id: string | null): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** Re-runs `load` whenever a live event passes `relevant` (debounced), and on reconnect. */
export function useLiveReload(load: () => void, relevant: (e: RealtimeSessionEvent) => boolean = () => true) {
  const { subscribe } = useSession();
  const fn = useRef({ load, relevant });
  fn.current = { load, relevant };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe((e) => {
      if (!fn.current.relevant(e)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.current.load(), 120);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe]);
}

const STATE_EVENTS = new Set([
  'SESSION_STARTED',
  'SESSION_ENDED',
  'PARTICIPANT_JOINED',
  'PARTICIPANT_REMOVED',
  'SESSION_SETTINGS_UPDATED',
  'PRESENCE_CHANGED',
]);

function readUrl(): { tab: TabKey; q: string | null } {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get('tab');
  return { tab: tab === 'questions' || tab === 'host' ? tab : 'play', q: p.get('q') };
}

interface Props {
  code: string;
  token: string;
  initialState: SessionStateView;
  /** Access ended: the token stopped working, or the host removed this person. */
  onUnauthorized(reason?: 'removed'): void;
  children: ReactNode;
}

export function SessionProvider({ code, token, initialState, onUnauthorized, children }: Props) {
  const [state, setState] = useState(initialState);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [unread, setUnread] = useState(initialState.unreadNotifications);
  const [toasts, setToasts] = useState<NotificationView[]>([]);
  const [nav, setNav] = useState<{ tab: TabKey; q: string | null }>({ tab: 'play', q: null });
  const listeners = useRef(new Set<(e: RealtimeSessionEvent) => void>());
  const chatListeners = useRef(new Set<(m: ChatMessageView) => void>());

  const call = useCallback(
    async <T,>(path: string, opts: Omit<ApiOptions, 'token'> = {}) => {
      try {
        return await api<T>(path, { ...opts, token });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'REMOVED') onUnauthorized('removed');
        else if (err instanceof ApiError && err.status === 401) onUnauthorized();
        throw err;
      }
    },
    [token, onUnauthorized],
  );

  const refresh = useCallback(async () => {
    try {
      setState(await call<SessionStateView>(`/api/sessions/${code}`));
    } catch {
      /* the connection banner already tells the user; the next event retries */
    }
  }, [call, code]);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await call<{ items: NotificationView[]; unread: number }>(`/api/sessions/${code}/notifications`);
      setNotifications(res.items);
      setUnread(res.unread);
    } catch {
      /* non-critical */
    }
  }, [call, code]);

  // the tab and the open question live in the URL so a refresh restores them
  useEffect(() => {
    setNav(readUrl());
    const onPop = () => setNav(readUrl());
    window.addEventListener('popstate', onPop);
    void loadNotifications();
    return () => window.removeEventListener('popstate', onPop);
  }, [loadNotifications]);

  const navigate = useCallback((next: { tab: TabKey; q: string | null }, push: boolean) => {
    const p = new URLSearchParams();
    if (next.tab !== 'play') p.set('tab', next.tab);
    if (next.q) p.set('q', next.q);
    const url = window.location.pathname + (p.size ? `?${p}` : '');
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    setNav(next);
  }, []);

  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connection = useSessionSocket(token, {
    onSessionEvent: (event) => {
      if (STATE_EVENTS.has(event.type)) {
        if (stateTimer.current) clearTimeout(stateTimer.current);
        stateTimer.current = setTimeout(() => void refresh(), 150);
      }
      listeners.current.forEach((l) => l(event));
    },
    onNotification: (n) => {
      setNotifications((list) => [n, ...list.filter((x) => x.id !== n.id)].slice(0, 50));
      setUnread((u) => u + 1);
      // routine activity only goes to the bell; pop-ups are for things worth interrupting for
      if (n.type !== 'NEW_ANSWER') setToasts((list) => [...list.filter((x) => x.id !== n.id), n].slice(-3));
    },
    onChatMessage: (m) => chatListeners.current.forEach((l) => l(m)),
    onReconnect: () => {
      // anything may have happened while offline: re-sync everything
      void refresh();
      void loadNotifications();
      listeners.current.forEach((l) => l({ type: 'RESYNC', questionId: null, data: {}, at: new Date().toISOString() }));
    },
  });

  useEffect(() => {
    if (connection === 'unauthorized') onUnauthorized();
    if (connection === 'removed') onUnauthorized('removed');
  }, [connection, onUnauthorized]);

  // stable identities: consumers keep timers/effects keyed on these
  const subscribe = useCallback((listener: (e: RealtimeSessionEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const subscribeChat = useCallback((listener: (m: ChatMessageView) => void) => {
    chatListeners.current.add(listener);
    return () => {
      chatListeners.current.delete(listener);
    };
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const markRead = useCallback(
    (ids: string[] | null) => {
      setNotifications((list) => list.map((n) => (ids === null || ids.includes(n.id) ? { ...n, read: true } : n)));
      call<{ unread: number }>(`/api/sessions/${code}/notifications`, { json: { ids } })
        .then((r) => setUnread(r.unread))
        .catch(() => {});
    },
    [call, code],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      code,
      token,
      state,
      connection,
      call,
      refresh,
      subscribe,
      subscribeChat,
      notifications,
      unread,
      toasts,
      dismissToast,
      markRead,
      tab: nav.tab,
      setTab: (tab) => navigate({ tab, q: null }, true),
      openQuestionId: nav.q,
      openQuestion: (id) => navigate({ tab: id && nav.tab === 'play' ? 'questions' : nav.tab, q: id }, true),
    }),
    [code, token, state, connection, call, refresh, subscribe, subscribeChat, notifications, unread, toasts, dismissToast, markRead, nav, navigate],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
