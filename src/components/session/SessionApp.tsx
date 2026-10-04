'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/client/api';
import { adoptTokenFromHash, clearToken, getToken, saveToken, storePendingRequest } from '@/lib/client/tokenStore';
import type { SessionStateView } from '@/lib/domain/views';
import { ChatAlert } from '@/components/chat/ChatAlert';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ChatProvider, useChat } from '@/components/chat/ChatProvider';
import { HostDashboard } from '@/components/host/HostDashboard';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Toasts } from '@/components/notifications/Toasts';
import { QuestionDetail } from '@/components/questions/QuestionDetail';
import { QuestionsTab } from '@/components/questions/QuestionsTab';
import { PlayTab } from '@/components/submissions/PlayTab';
import { Card, ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button, Spinner } from '@/components/ui/Button';
import { JoinRequests } from './JoinRequests';
import { SessionHeader } from './SessionHeader';
import { SessionProvider, useSession } from './SessionProvider';
import { WaitingRoom } from './WaitingRoom';

type Phase =
  | { kind: 'loading' }
  | { kind: 'join'; notice?: string }
  | { kind: 'missing' }
  | { kind: 'removed' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; token: string; state: SessionStateView };

/** Entry point for /s/[code]: resolves identity, then renders the session. */
export function SessionApp({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const load = useCallback(async () => {
    adoptTokenFromHash(code);
    const token = getToken(code);
    if (!token) return setPhase({ kind: 'join' });
    try {
      const state = await api<SessionStateView>(`/api/sessions/${code}`, { token });
      setPhase({ kind: 'ready', token, state });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REMOVED') {
        clearToken(code);
        setPhase({ kind: 'removed' });
      } else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearToken(code);
        setPhase({ kind: 'join', notice: 'Your previous access to this session is no longer valid. Join again to continue.' });
      } else if (err instanceof ApiError && err.status === 404) setPhase({ kind: 'missing' });
      else setPhase({ kind: 'error', message: errorMessage(err) });
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  const onUnauthorized = useCallback((reason?: 'removed') => {
    clearToken(code);
    if (reason === 'removed') return setPhase({ kind: 'removed' });
    setPhase({ kind: 'join', notice: 'Your access to this session expired. Join again to continue.' });
  }, [code]);

  if (phase.kind === 'loading')
    return (
      <Centered>
        <Spinner className="h-6 w-6 text-indigo-600" />
      </Centered>
    );
  if (phase.kind === 'missing')
    return (
      <Centered>
        <h1 className="text-xl font-semibold">Session not found</h1>
        <p className="text-sm text-slate-600">
          There is no session with the code <span className="font-mono font-semibold">{code}</span>. Check the code and try again.
        </p>
        <Link href="/" className="text-sm font-medium text-indigo-600 hover:underline">
          Back to start
        </Link>
      </Centered>
    );
  if (phase.kind === 'removed')
    return (
      <Centered>
        <p className="text-4xl" aria-hidden="true">🚪</p>
        <h1 className="text-xl font-semibold">You were removed from this session</h1>
        <p className="text-sm text-slate-600">The host removed you, so you can no longer see or post in it. Your earlier answers stay part of the session.</p>
        <Link href="/" className="text-sm font-medium text-indigo-600 hover:underline">
          Back to start
        </Link>
      </Centered>
    );
  if (phase.kind === 'error')
    return (
      <Centered>
        <ErrorNote>{phase.message}</ErrorNote>
        <Button onClick={() => void load()}>Try again</Button>
      </Centered>
    );
  if (phase.kind === 'join') return <JoinGate code={code} notice={phase.notice} onJoined={load} />;

  return (
    <SessionProvider code={code} token={phase.token} initialState={phase.state} onUnauthorized={onUnauthorized}>
      <ChatProvider>
        <SessionShell />
      </ChatProvider>
    </SessionProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <ThemeToggle className="absolute right-4 top-4" />
      {children}
    </main>
  );
}

function JoinGate({ code, notice, onJoined }: { code: string; notice?: string; onJoined: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>(`/api/sessions/${code}/join`, { json: { displayName: name } });
      saveToken(code, res.token);
      onJoined();
    } catch (err) {
      // the host approves everyone: turn this into a request and wait on the home page
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED') {
        try {
          const req = await api<{ token: string; sessionName: string }>(`/api/sessions/${code}/join-requests`, { json: { displayName: name } });
          storePendingRequest({ token: req.token, sessionId: '', sessionName: req.sessionName, displayName: name.trim() });
          router.push('/');
          return;
        } catch (inner) {
          setError(errorMessage(inner));
          setBusy(false);
          return;
        }
      }
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Centered>
      <Card className="w-full p-6 text-left">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Join session</p>
        <h1 className="mt-1 font-mono text-2xl font-semibold tracking-widest">{code}</h1>
        {notice && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}
        <form onSubmit={join} className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-slate-700" htmlFor="join-name">
            Your name
          </label>
          <input id="join-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus required placeholder="e.g. Sam" />
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" block busy={busy} disabled={!name.trim()}>
            Join session
          </Button>
        </form>
      </Card>
      <Link href="/" className="text-sm text-slate-500 hover:underline">
        Back to start
      </Link>
    </Centered>
  );
}

function SessionShell() {
  const { state, connection, tab, openQuestionId } = useSession();
  const chat = useChat();
  const waiting = state.session.status === 'WAITING';
  const showHost = tab === 'host' && state.caps.canViewDashboard;

  return (
    // on wider screens the open chat panel sits beside the content instead of over it
    <div className={`min-h-dvh ${chat.open && chat.enabled ? 'sm:pr-96' : ''}`}>
      <SessionHeader />
      {connection !== 'connected' && (
        <div role="status" className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-sm text-amber-900">
          <Spinner className="h-3.5 w-3.5" />
          {connection === 'connecting' ? 'Connecting…' : 'Reconnecting… live updates are paused'}
        </div>
      )}
      {state.session.status === 'ENDED' && (
        <div className="bg-black/85 px-4 py-1.5 text-center text-sm text-onaccent">This session has ended. Results stay available to browse.</div>
      )}
      <main className="mx-auto max-w-3xl px-4 py-5">
        {state.caps.canAdmit && <JoinRequests />}
        {waiting ? (
          <WaitingRoom />
        ) : openQuestionId ? (
          <QuestionDetail key={openQuestionId} questionId={openQuestionId} />
        ) : showHost ? (
          <HostDashboard />
        ) : tab === 'questions' ? (
          <QuestionsTab />
        ) : (
          <PlayTab />
        )}
      </main>
      <ChatPanel />
      <ChatAlert />
      <Toasts />
    </div>
  );
}
