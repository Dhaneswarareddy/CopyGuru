'use client';
import { useEffect, useRef, useState } from 'react';
import type { NotificationView } from '@/lib/domain/views';
import { useSession } from '@/components/session/SessionProvider';

export function timeAgo(isoDate: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(isoDate).toLocaleDateString();
}

/** 24-hour wall-clock time for activity feeds. */
export const clock = (isoDate: string) =>
  new Date(isoDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const NOTIFICATION_ICON: Record<string, string> = {
  CHALLENGE: '⚠️',
  NEW_ANSWER: '💬',
  CONSENSUS: '📊',
  CHALLENGE_RESOLVED: '✅',
  JOIN_REQUEST: '🙋',
};

export function NotificationBell() {
  const { notifications, unread, markRead, openQuestion } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function visit(n: NotificationView) {
    if (!n.read) markRead([n.id]);
    setOpen(false);
    if (n.questionId) openQuestion(n.questionId);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        className="relative rounded-lg p-2 text-lg leading-none hover:bg-slate-100"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-rose-600 px-1 text-center text-xs font-semibold leading-5 text-onaccent">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && (
              <button type="button" onClick={() => markRead(null)} className="text-xs font-medium text-indigo-600 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-500">Nothing yet. Challenges and new answers will show up here.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => visit(n)} className={`flex w-full gap-2 px-3 py-2.5 text-left hover:bg-slate-50 ${n.read ? '' : 'bg-indigo-50/60'}`}>
                    <span aria-hidden="true">{NOTIFICATION_ICON[n.type] ?? '•'}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${n.read ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>{n.title}</span>
                      {n.body && <span className="block text-xs text-slate-600">{n.body}</span>}
                      <span className="block text-xs text-slate-400">{timeAgo(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
