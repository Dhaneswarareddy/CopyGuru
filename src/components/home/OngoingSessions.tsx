'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/client/api';
import {
  getLastName,
  getPendingRequest,
  rememberName,
  saveToken,
  storePendingRequest,
  type PendingJoinRequest,
} from '@/lib/client/tokenStore';
import type { JoinRequestStatusView, PublicSessionView } from '@/lib/domain/views';
import { Badge, Card, ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button, Spinner } from '@/components/ui/Button';

const LIST_REFRESH_MS = 8000;
const STATUS_POLL_MS = 2500;

/**
 * Home page: sessions that are running right now and open to requests.
 * "Ask to join" puts the visitor in a waiting state until a host admits or
 * declines them; the page then moves them into the session by itself.
 */
export function OngoingSessions() {
  const router = useRouter();
  const [sessions, setSessions] = useState<PublicSessionView[] | null>(null);
  const [listError, setListError] = useState(false);
  const [asking, setAsking] = useState<string | null>(null); // session id whose form is open
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingJoinRequest | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      setSessions((await api<{ items: PublicSessionView[] }>('/api/sessions')).items);
      setListError(false);
    } catch {
      setListError(true);
    }
  }, []);

  useEffect(() => {
    setPending(getPendingRequest()); // a refresh keeps you in the queue
    setName(getLastName());
    void loadList();
    const timer = setInterval(() => document.visibilityState === 'visible' && void loadList(), LIST_REFRESH_MS);
    // the "join with a code" form starts a request when the host approves everyone
    const onRequest = () => {
      setOutcome(null);
      setPending(getPendingRequest());
    };
    window.addEventListener('vqa:join-request', onRequest);
    return () => {
      clearInterval(timer);
      window.removeEventListener('vqa:join-request', onRequest);
    };
  }, [loadList]);

  const finish = useCallback((message: string | null) => {
    storePendingRequest(null);
    setPending(null);
    setOutcome(message);
  }, []);

  // while waiting, keep asking the server what the host decided
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const check = async () => {
      try {
        const s = await api<JoinRequestStatusView>('/api/join-requests/me', { token: pending.token });
        if (stopped) return;
        if (s.status === 'APPROVED' && s.code) {
          saveToken(s.code, pending.token); // the same token is now this person's session access
          storePendingRequest(null);
          router.push(`/s/${s.code}`);
        } else if (s.status === 'DECLINED') finish(`The host declined your request to join “${s.sessionName}”.`);
        else if (s.status === 'CLOSED') finish(`“${s.sessionName}” has ended.`);
        else if (s.status === 'CANCELLED') finish(null);
      } catch (err) {
        // a request the server no longer knows is over; network blips just retry
        if (!stopped && err instanceof ApiError && (err.status === 401 || err.status === 403)) finish('Your request to join is no longer valid.');
      }
    };
    void check();
    const timer = setInterval(check, STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pending, router, finish]);

  async function request(e: React.FormEvent, session: PublicSessionView) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await api<{ token: string; sessionName: string }>(`/api/sessions/${session.id}/join-requests`, { json: { displayName: name } });
      const next = { token: res.token, sessionId: session.id, sessionName: res.sessionName, displayName: name.trim() };
      rememberName(name.trim());
      storePendingRequest(next);
      setPending(next);
      setAsking(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!pending) return;
    const token = pending.token;
    finish(null);
    await api('/api/join-requests/me', { method: 'DELETE', token }).catch(() => {});
  }

  return (
    <Card className="mb-6 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Happening now</h2>
        <span className="text-xs text-slate-500">Updates automatically</span>
      </div>

      {pending && (
        <div role="status" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
          <Spinner className="h-4 w-4 text-indigo-600" />
          <p className="min-w-0 flex-1 text-sm text-slate-800">
            Waiting for the host of <strong>“{pending.sessionName}”</strong> to let you in as <strong>{pending.displayName}</strong>. Keep this page open.
          </p>
          <Button size="sm" variant="secondary" onClick={cancel}>
            Cancel request
          </Button>
        </div>
      )}
      {outcome && (
        <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {outcome}
        </p>
      )}

      {sessions === null && !listError && (
        <div className="flex justify-center py-4 text-indigo-600">
          <Spinner className="h-5 w-5" />
        </div>
      )}
      {listError && sessions === null && (
        <p className="mt-3 text-sm text-slate-600">
          The list of sessions could not be loaded.{' '}
          <button type="button" className="font-medium text-indigo-600 hover:underline" onClick={() => void loadList()}>
            Try again
          </button>
        </p>
      )}
      {sessions?.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No open sessions right now. Join one with a code, or host your own below.</p>
      )}

      {sessions && sessions.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100">
          {sessions.map((s) => (
            <li key={s.id} className="py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{s.name}</p>
                  <p className="text-xs text-slate-500">
                    Hosted by {s.hostName} · {s.participantCount} {s.participantCount === 1 ? 'person' : 'people'}
                  </p>
                </div>
                <Badge tone={s.status === 'ACTIVE' ? 'green' : 'neutral'}>{s.status === 'ACTIVE' ? 'In progress' : 'Waiting to start'}</Badge>
                {pending && pending.sessionId === s.id ? (
                  <Badge tone="indigo">Request sent</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!pending}
                    onClick={() => {
                      setAsking(asking === s.id ? null : s.id);
                      setError(null);
                    }}
                    aria-expanded={asking === s.id}
                    aria-label={`Ask to join ${s.name}`}
                  >
                    Ask to join
                  </Button>
                )}
              </div>
              {asking === s.id && !pending && (
                <form onSubmit={(e) => request(e, s)} className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
                  <label htmlFor={`ask-name-${s.id}`} className="block text-sm font-medium text-slate-700">
                    Your name
                  </label>
                  <div className="flex gap-2">
                    <input id={`ask-name-${s.id}`} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Sam" autoFocus required />
                    <Button type="submit" busy={busy} disabled={!name.trim()}>
                      Send request
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500">The host sees your name and decides whether to let you in.</p>
                  <ErrorNote>{error}</ErrorNote>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
