'use client';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import type { JoinRequestView } from '@/lib/domain/views';
import { ErrorNote } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useLiveReload, useSession } from './SessionProvider';

const RELEVANT = new Set(['JOIN_REQUESTED', 'JOIN_REQUEST_APPROVED', 'JOIN_REQUEST_DECLINED', 'JOIN_REQUEST_CANCELLED', 'RESYNC']);

/**
 * Host-only strip at the top of the session: people who asked to join from
 * the home page, with Admit / Decline. Renders nothing when nobody is waiting.
 */
export function JoinRequests() {
  const { call, code } = useSession();
  const [items, setItems] = useState<JoinRequestView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await call<{ items: JoinRequestView[] }>(`/api/sessions/${code}/join-requests`)).items);
    } catch {
      /* keep what we have; the next event or tick retries */
    }
  }, [call, code]);

  useEffect(() => {
    void load();
    // visitors who close their tab drop out without an event, so refresh on a timer too
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);
  useLiveReload(load, (e) => RELEVANT.has(e.type));

  async function decide(request: JoinRequestView, decision: 'APPROVE' | 'DECLINE') {
    setBusy(request.id + decision);
    setError(null);
    try {
      setItems((await call<{ items: JoinRequestView[] }>(`/api/join-requests/${request.id}/decision`, { json: { decision } })).items);
    } catch (err) {
      setError(errorMessage(err));
      void load();
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0 && !error) return null;

  return (
    <section aria-label="People asking to join" className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
      <h2 className="text-sm font-semibold text-slate-900">
        {items.length === 1 ? '1 person is asking to join' : `${items.length} people are asking to join`}
      </h2>
      <ul className="mt-2 space-y-2">
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">🙋 {r.displayName}</span>
            <Button size="sm" busy={busy === r.id + 'APPROVE'} disabled={!!busy} onClick={() => decide(r, 'APPROVE')} aria-label={`Admit ${r.displayName}`}>
              Admit
            </Button>
            <Button size="sm" variant="secondary" busy={busy === r.id + 'DECLINE'} disabled={!!busy} onClick={() => decide(r, 'DECLINE')} aria-label={`Decline ${r.displayName}`}>
              Decline
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </section>
  );
}
