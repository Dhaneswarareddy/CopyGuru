'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/client/api';
import type { ChatMessageView, ChatOverviewView, ChatThreadView } from '@/lib/domain/views';
import { useSession } from '@/components/session/SessionProvider';

/** "public" (everyone) or the id of the participant in a private conversation. */
export type Channel = string;
export const PUBLIC: Channel = 'public';

interface Thread {
  messages: ChatMessageView[];
  loaded: boolean;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}
const EMPTY: Thread = { messages: [], loaded: false, hasMore: false, loading: false, error: null };

interface ChatContextValue {
  enabled: boolean;
  privateEnabled: boolean;
  canSend: boolean;
  open: boolean;
  channel: Channel;
  thread: Thread;
  /** Unread count per channel. */
  unread: Record<Channel, number>;
  totalUnread: number;
  /** Opens the panel, optionally straight into a conversation. */
  show(channel?: Channel): void;
  hide(): void;
  select(channel: Channel): void;
  send(text: string): Promise<void>;
  loadEarlier(): void;
  /** The latest private message that arrived out of view, for a pop-up. */
  alert: ChatMessageView | null;
  dismissAlert(): void;
}

const ChatContext = createContext<ChatContextValue | null>(null);
export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside <ChatProvider>');
  return ctx;
}

const channelOf = (m: ChatMessageView, me: string): Channel => (m.recipientId === null ? PUBLIC : m.senderId === me ? m.recipientId : m.senderId);
const merge = (existing: ChatMessageView[], incoming: ChatMessageView[]) => {
  const byId = new Map(existing.map((m) => [m.id, m]));
  incoming.forEach((m) => byId.set(m.id, m));
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
};

/**
 * Chat state for the session: which conversations exist, what is unread, and
 * the messages of conversations that have been opened. Mounted for the whole
 * session so unread badges stay live while the panel is closed.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const { call, code, state, subscribe, subscribeChat } = useSession();
  const me = state.me.id;
  const [overview, setOverview] = useState<ChatOverviewView | null>(null);
  const [unread, setUnread] = useState<Record<Channel, number>>({});
  const [threads, setThreads] = useState<Record<Channel, Thread>>({});
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>(PUBLIC);
  const [alert, setAlert] = useState<ChatMessageView | null>(null);
  const dismissAlert = useCallback(() => setAlert(null), []);
  const live = useRef({ open, channel, threads });
  live.current = { open, channel, threads };

  const applyOverview = useCallback((o: ChatOverviewView) => {
    setOverview(o);
    setUnread({ [PUBLIC]: o.publicUnread, ...Object.fromEntries(o.direct.map((d) => [d.participantId, d.unread])) });
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      applyOverview(await call<ChatOverviewView>(`/api/sessions/${code}/chat`));
    } catch {
      /* the badge simply stays as it was; the next event or reconnect retries */
    }
  }, [call, code, applyOverview]);

  const patch = useCallback((ch: Channel, fn: (t: Thread) => Thread) => {
    setThreads((all) => ({ ...all, [ch]: fn(all[ch] ?? EMPTY) }));
  }, []);

  const markRead = useCallback(
    (ch: Channel, messages: ChatMessageView[]) => {
      const last = messages[messages.length - 1];
      setUnread((u) => (u[ch] ? { ...u, [ch]: 0 } : u));
      if (last) call(`/api/sessions/${code}/chat/read`, { json: { channel: ch, lastId: last.id } }).catch(() => {});
    },
    [call, code],
  );

  const loadThread = useCallback(
    async (ch: Channel, before?: string) => {
      patch(ch, (t) => ({ ...t, loading: true, error: null }));
      try {
        const q = new URLSearchParams({ with: ch });
        if (before) q.set('before', before);
        const res = await call<ChatThreadView>(`/api/sessions/${code}/chat/messages?${q}`);
        let merged: ChatMessageView[] = [];
        setThreads((all) => {
          const t = all[ch] ?? EMPTY;
          merged = merge(t.messages, res.items);
          // "has more" only describes older history, so a refresh must not clear it
          return { ...all, [ch]: { messages: merged, loaded: true, loading: false, error: null, hasMore: before || !t.loaded ? res.hasMore : t.hasMore } };
        });
        if (live.current.open && live.current.channel === ch) markRead(ch, merged.length ? merged : res.items);
      } catch (err) {
        patch(ch, (t) => ({ ...t, loading: false, error: errorMessage(err) }));
      }
    },
    [call, code, patch, markRead],
  );

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  // settings can change what chat is available (and a reconnect may have missed messages)
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'RESYNC') {
          void loadOverview();
          Object.keys(live.current.threads).forEach((ch) => live.current.threads[ch].loaded && void loadThread(ch));
        } else if (e.type === 'SESSION_ENDED' || e.type === 'SESSION_SETTINGS_UPDATED') void loadOverview();
      }),
    [subscribe, loadOverview, loadThread],
  );

  useEffect(
    () =>
      subscribeChat((m) => {
        const ch = channelOf(m, me);
        const { open: isOpen, channel: active, threads: current } = live.current;
        if (current[ch]?.loaded) patch(ch, (t) => ({ ...t, messages: merge(t.messages, [m]) }));
        if (m.senderId === me) return;
        if (isOpen && active === ch && document.visibilityState === 'visible') markRead(ch, [m]);
        else {
          setUnread((u) => ({ ...u, [ch]: (u[ch] ?? 0) + 1 }));
          if (m.recipientId !== null) setAlert(m); // private messages are easy to miss behind a badge
        }
      }),
    [subscribeChat, me, patch, markRead],
  );

  const select = useCallback(
    (ch: Channel) => {
      setChannel(ch);
      const t = live.current.threads[ch];
      if (!t?.loaded) void loadThread(ch);
      else if (live.current.open) markRead(ch, t.messages);
    },
    [loadThread, markRead],
  );

  const show = useCallback(
    (ch?: Channel) => {
      const target = ch ?? live.current.channel;
      live.current.open = true; // so the load below marks the conversation read
      setOpen(true);
      setChannel(target);
      setAlert((a) => (a && a.senderId === target ? null : a));
      const t = live.current.threads[target];
      if (!t?.loaded) void loadThread(target);
      else markRead(target, t.messages);
    },
    [loadThread, markRead],
  );

  const send = useCallback(
    async (text: string) => {
      const ch = live.current.channel;
      const message = await call<ChatMessageView>(`/api/sessions/${code}/chat/messages`, { json: { to: ch, text } });
      patch(ch, (t) => ({ ...t, messages: merge(t.messages, [message]) })); // the socket echo is de-duplicated by id
    },
    [call, code, patch],
  );

  const value = useMemo<ChatContextValue>(() => {
    const enabled = overview?.enabled ?? false;
    const privateEnabled = overview?.privateEnabled ?? false;
    // if private chat was switched off, fall back to the public channel
    const active = channel !== PUBLIC && !privateEnabled ? PUBLIC : channel;
    return {
      enabled,
      privateEnabled,
      canSend: (overview?.canSend ?? false) && state.session.status !== 'ENDED',
      open,
      channel: active,
      thread: threads[active] ?? EMPTY,
      unread,
      totalUnread: Object.values(unread).reduce((a, b) => a + b, 0),
      show,
      hide: () => setOpen(false),
      select,
      send,
      alert,
      dismissAlert,
      loadEarlier: () => {
        const first = (threads[active] ?? EMPTY).messages[0];
        if (first) void loadThread(active, first.id);
      },
    };
  }, [overview, state.session.status, open, channel, threads, unread, show, select, send, loadThread, alert, dismissAlert]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
