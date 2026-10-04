'use client';
import { useState } from 'react';
import { ChatButton } from '@/components/chat/ChatButton';
import { useChat } from '@/components/chat/ChatProvider';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { ParticipantList } from '@/components/participants/ParticipantList';
import { Badge } from '@/components/ui/Badge';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useSession, type TabKey } from './SessionProvider';

export function SessionHeader() {
  const { state, tab, setTab, openQuestionId, call, code, refresh } = useSession();
  const chat = useChat();
  const [showPeople, setShowPeople] = useState(false);
  const [copied, setCopied] = useState(false);
  const { session, me, participants, caps } = state;
  const online = participants.filter((p) => p.online).length;

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'play', label: 'Play' },
    { key: 'questions', label: 'Questions' },
    ...(caps.canViewDashboard ? [{ key: 'host' as const, label: 'Host' }] : []),
  ];

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${session.code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; the code is visible anyway */
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="brand-bar h-1" aria-hidden="true" />
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-slate-900">{session.name}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <button type="button" onClick={copyCode} title="Copy invite link" className="rounded-md bg-indigo-50 px-1.5 py-0.5 font-mono font-bold tracking-wider text-indigo-700 hover:bg-indigo-100">
              {session.code}
            </button>
            <span aria-live="polite">{copied ? 'Link copied' : ''}</span>
            <span>
              {me.displayName}
              {me.role === 'HOST' && ' · Host'}
            </span>
            {session.isDemo && <Badge tone="indigo">Demo</Badge>}
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowPeople((v) => !v)}
            aria-expanded={showPeople}
            className="rounded-lg px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            title="Participants"
          >
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
            {online}/{participants.length}
          </button>
          {showPeople && (
            <div className="absolute right-0 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
              <ParticipantList
                participants={participants}
                onMessage={
                  chat.privateEnabled
                    ? (p) => {
                        setShowPeople(false);
                        chat.show(p.id);
                      }
                    : undefined
                }
                onRemove={
                  caps.canRemoveParticipants
                    ? async (p) => {
                        await call(`/api/sessions/${code}/participants/${p.id}/remove`, { method: 'POST' });
                        await refresh();
                      }
                    : undefined
                }
              />
            </div>
          )}
        </div>
        <ChatButton />
        <NotificationBell />
        <ThemeToggle />
      </div>
      {session.status !== 'WAITING' && (
        <nav className="mx-auto mt-2 flex max-w-3xl gap-1 px-4" aria-label="Session sections">
          {tabs.map((t) => {
            const active = !openQuestionId && tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold uppercase tracking-wide ${
                  active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      )}
    </header>
  );
}
