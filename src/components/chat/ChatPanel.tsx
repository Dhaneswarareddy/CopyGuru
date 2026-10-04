'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import { useSession } from '@/components/session/SessionProvider';
import { ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button, Spinner } from '@/components/ui/Button';
import { PUBLIC, useChat } from './ChatProvider';

const MAX_LENGTH = 1000;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Side panel with the session chat. "To" chooses between Everyone and a
 * private conversation with one participant.
 */
export function ChatPanel() {
  const { state } = useSession();
  const chat = useChat();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  const { open, channel, thread } = chat;
  const others = state.participants.filter((p) => !p.isMe);
  const peer = channel === PUBLIC ? null : (others.find((p) => p.id === channel) ?? null);
  const lastId = thread.messages[thread.messages.length - 1]?.id;

  // keep the newest message in view unless the reader has scrolled up
  useLayoutEffect(() => {
    if (open && stickToBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [open, channel, lastId, thread.loaded]);

  // grow the box with the message, up to its max height
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft, open]);

  useEffect(() => {
    stickToBottom.current = true;
    setError(null);
    if (open) input.current?.focus();
  }, [open, channel]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && chat.hide();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, chat]);

  if (!chat.enabled || !open) return null;

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await chat.send(text);
      setDraft('');
      stickToBottom.current = true;
    } catch (err) {
      setError(errorMessage(err)); // the draft stays so nothing typed is lost
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }

  const label = (name: string, count: number) => (count > 0 ? `${name} (${count} new)` : name);

  return (
    <aside
      aria-label="Chat"
      className="fixed inset-y-0 right-0 z-[35] flex w-full flex-col border-l border-slate-200 bg-white shadow-xl sm:w-96"
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="flex-1 text-base font-semibold text-slate-900">Chat</h2>
        <button type="button" onClick={chat.hide} aria-label="Close chat" className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
          ✕
        </button>
      </div>

      <div className="border-b border-slate-200 px-4 py-2">
        <label htmlFor="chat-to" className="mr-2 text-sm font-medium text-slate-700">
          To
        </label>
        <select id="chat-to" className={`${inputClass} inline-block w-auto max-w-[80%]`} value={channel} onChange={(e) => chat.select(e.target.value)}>
          <option value={PUBLIC}>{label('Everyone', chat.unread[PUBLIC] ?? 0)}</option>
          {chat.privateEnabled && others.length > 0 && (
            <optgroup label="Private message">
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {label(`${p.displayName}${p.role === 'HOST' ? ' (host)' : ''}`, chat.unread[p.id] ?? 0)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <p className={`mt-1.5 text-xs ${peer ? 'text-indigo-700' : 'text-slate-500'}`}>
          {peer
            ? `🔒 Private. Only you and ${peer.displayName} can see this conversation.`
            : channel !== PUBLIC
              ? 'This person is no longer in the session.'
              : 'Everyone in this session can see these messages.'}
          {!chat.privateEnabled && ' Private messages are turned off in this session.'}
        </p>
      </div>

      <div
        ref={list}
        className="flex-1 space-y-2 overflow-y-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {thread.hasMore && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" busy={thread.loading} onClick={chat.loadEarlier}>
              Show earlier messages
            </Button>
          </div>
        )}
        {!thread.loaded && thread.loading && (
          <div className="flex justify-center py-6 text-indigo-600">
            <Spinner className="h-5 w-5" />
          </div>
        )}
        {thread.error && <ErrorNote>{thread.error}</ErrorNote>}
        {thread.loaded && thread.messages.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">
            {peer ? `No messages with ${peer.displayName} yet. Say hello.` : 'No messages yet. Start the conversation.'}
          </p>
        )}
        <ol className="space-y-2" aria-live="polite">
          {thread.messages.map((m, i) => {
            const mine = m.senderId === state.me.id;
            const previous = thread.messages[i - 1];
            const showName = !mine && (!previous || previous.senderId !== m.senderId);
            return (
              <li key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                {showName && <span className="mb-0.5 px-1 text-xs font-medium text-slate-600">{m.senderName}</span>}
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                    mine ? 'rounded-br-md bg-accent text-onaccent' : 'rounded-bl-md bg-slate-100 text-slate-900'
                  }`}
                >
                  {m.text}
                </div>
                <time className="mt-0.5 px-1 text-[11px] text-slate-400" dateTime={m.createdAt}>
                  {time(m.createdAt)}
                </time>
              </li>
            );
          })}
        </ol>
      </div>

      <form
        className="border-t border-slate-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {chat.canSend ? (
          <>
            <div className="mb-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
            <div className="flex items-end gap-2">
              <textarea
                ref={input}
                className={`${inputClass} max-h-32 resize-none`}
                rows={1}
                value={draft}
                maxLength={MAX_LENGTH}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter makes a new line (and never while composing with an IME)
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder={peer ? `Message ${peer.displayName} privately` : 'Message everyone'}
                aria-label={peer ? `Private message to ${peer.displayName}` : 'Message to everyone'}
                disabled={channel !== PUBLIC && !peer}
              />
              <Button type="submit" busy={sending} disabled={!draft.trim() || (channel !== PUBLIC && !peer)}>
                Send
              </Button>
            </div>
          </>
        ) : (
          <p className="text-center text-sm text-slate-500">The session has ended, so chat is closed. Messages stay readable.</p>
        )}
      </form>
    </aside>
  );
}
