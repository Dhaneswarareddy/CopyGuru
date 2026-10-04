'use client';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import type { DashboardView } from '@/lib/domain/views';
import { clock } from '@/components/notifications/NotificationBell';
import { LEVEL_LABEL } from '@/components/questions/ConsensusMeter';
import { HostTools } from './HostTools';
import { useLiveReload, useSession } from '@/components/session/SessionProvider';
import { Card, ErrorNote } from '@/components/ui/Badge';
import { Button, Spinner } from '@/components/ui/Button';

export function HostDashboard() {
  const { call, code, state, openQuestion, refresh } = useSession();
  const [data, setData] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<'idle' | 'confirm' | 'busy'>('idle');

  const load = useCallback(async () => {
    try {
      setData(await call<DashboardView>(`/api/sessions/${code}/dashboard`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [call, code]);

  useEffect(() => {
    void load();
  }, [load]);
  useLiveReload(load);

  async function end() {
    setEnding('busy');
    try {
      await call(`/api/sessions/${code}/end`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
    setEnding('idle');
  }

  if (!data)
    return error ? (
      <ErrorNote>{error}</ErrorNote>
    ) : (
      <div className="flex justify-center py-10 text-indigo-600">
        <Spinner className="h-6 w-6" />
      </div>
    );

  const s = data.stats;
  const tiles: [string, number | string][] = [
    ['Participants', `${s.participants} (${s.online} online)`],
    ['Questions', s.questions],
    ['Answers', s.answers],
    ['Images', s.images],
    ['Challenges', s.challenges],
    ['Open', s.openChallenges],
    ['Resolved', s.resolvedChallenges],
  ];

  return (
    <section aria-label="Host dashboard" className="space-y-4">
      <ErrorNote>{error}</ErrorNote>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <Card key={label} className="p-3">
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{value}</dd>
          </Card>
        ))}
      </dl>

      <Card className="overflow-hidden">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">Question overview</h2>
        {data.questions.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">No questions yet. They appear here as participants post.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-2 py-2 font-medium">Question</th>
                  <th className="px-2 py-2 text-right font-medium">Answers</th>
                  <th className="px-2 py-2 text-right font-medium">Consensus</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.questions.map((q) => (
                  <tr key={q.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 tabular-nums text-slate-500">{q.number}</td>
                    <td className="px-2 py-2">
                      <button type="button" className="flex items-center gap-2 text-left" onClick={() => openQuestion(q.id)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {q.thumbUrl && <img src={q.thumbUrl} alt="" loading="lazy" className="h-9 w-9 rounded object-cover" />}
                        <span className="max-w-40 truncate font-medium text-slate-800">{q.tally?.[0]?.label ?? 'Image'}</span>
                      </button>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{q.answerCount}</td>
                    <td className="px-2 py-2 text-right tabular-nums" title={q.consensus ? LEVEL_LABEL[q.consensus.level] : undefined}>
                      {q.consensus?.pct != null ? `${q.consensus.pct}%` : '–'}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {q.status === 'CHALLENGED' ? (
                        <span className="font-medium text-amber-700">⚠ Challenged</span>
                      ) : q.status === 'RESOLVED' ? (
                        <span className="text-emerald-700">✓ Resolved</span>
                      ) : (
                        <span className="text-slate-500">✓ Open</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <HostTools />

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Activity</h2>
        <ol className="max-h-80 space-y-1.5 overflow-y-auto text-sm">
          {data.events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <time className="shrink-0 whitespace-nowrap pt-0.5 text-xs tabular-nums text-slate-400" dateTime={e.createdAt}>
                  {clock(e.createdAt)}
                </time>
              <span className="text-slate-700">{e.summary}</span>
            </li>
          ))}
        </ol>
      </Card>

      {state.caps.canEnd && state.session.status === 'ACTIVE' && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <p className="flex-1 text-sm text-slate-600">Ending the session closes posting and challenges. Everything stays viewable.</p>
          {ending === 'idle' ? (
            <Button variant="danger" onClick={() => setEnding('confirm')}>
              End session
            </Button>
          ) : (
            <>
              <Button variant="danger" busy={ending === 'busy'} onClick={end}>
                Yes, end it
              </Button>
              <Button variant="ghost" onClick={() => setEnding('idle')} disabled={ending === 'busy'}>
                Keep running
              </Button>
            </>
          )}
        </Card>
      )}
    </section>
  );
}
