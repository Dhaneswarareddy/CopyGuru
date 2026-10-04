'use client';
import { useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import type { ChallengeResolution, ChallengeStance, ChallengeStatus } from '@/lib/domain/types';
import type { ChallengeView, QuestionDetailView } from '@/lib/domain/views';
import { useSession } from '@/components/session/SessionProvider';
import { Badge, ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

const STATUS: Record<ChallengeStatus, { label: string; tone: 'amber' | 'green' | 'neutral' }> = {
  OPEN: { label: 'Open challenge', tone: 'amber' },
  DISCUSSION: { label: 'In discussion', tone: 'amber' },
  RESOLVED: { label: 'Resolved', tone: 'green' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral' },
};

export const RESOLUTION_LABEL: Record<ChallengeResolution, string> = {
  ORIGINAL_ACCEPTED: 'Original answer accepted',
  CHALLENGE_ACCEPTED: 'Challenge accepted',
  BOTH_VALID: 'Both considered valid',
  UNRESOLVED: 'Left unresolved',
};

const people = (n: number) => `${n} ${n === 1 ? 'participant supports' : 'participants support'}`;

interface Props {
  challenge: ChallengeView;
  /** Viewer already has an answer on this question (it will not be changed). */
  hasAnswered: boolean;
  onChange(detail: QuestionDetailView): void;
}

export function ChallengePanel({ challenge: c, hasAnswered, onChange }: Props) {
  const { call } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const active = c.status === 'OPEN' || c.status === 'DISCUSSION';

  async function send(key: string, path: string, json: unknown) {
    setBusy(key);
    setError(null);
    try {
      onChange(await call<QuestionDetailView>(path, { json }));
      setOther(false);
      setText('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  const respond = (stance: ChallengeStance) =>
    send(stance, `/api/challenges/${c.id}/respond`, hasAnswered ? { stance, comment: text } : { stance, answer: text });
  const resolve = (outcome: ChallengeResolution | 'DISMISSED') =>
    send(outcome, `/api/challenges/${c.id}/resolve`, { outcome, note });

  return (
    <section className={`rounded-xl border p-4 ${active ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true">{active ? '⚠️' : '✓'}</span>
        <h3 className="text-sm font-semibold text-slate-900">Challenge by {c.challenge.by}</h3>
        <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg bg-white p-3 ring-1 ring-inset ring-slate-200">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Original answer · {c.original.by}</p>
          <p className="mt-1 break-words text-base font-semibold text-slate-900">{c.original.raw}</p>
          <p className="mt-1 text-xs text-slate-600">{people(c.tally.original)} the original</p>
        </div>
        <div className="rounded-lg bg-white p-3 ring-1 ring-inset ring-amber-300">
          <p className="text-xs font-medium uppercase tracking-wide text-amber-700">Challenged answer · {c.challenge.by}</p>
          <p className="mt-1 break-words text-base font-semibold text-slate-900">{c.challenge.raw}</p>
          <p className="mt-1 text-xs text-slate-600">{people(c.tally.challenge)} the challenge</p>
        </div>
      </div>
      {c.tally.other > 0 && <p className="mt-2 text-xs text-slate-600">{c.tally.other} responded with something else.</p>}
      {c.reason && (
        <p className="mt-3 text-sm text-slate-700">
          <span className="text-slate-500">Reason: </span>“{c.reason}”
        </p>
      )}

      {c.status === 'RESOLVED' && c.resolution && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Host decision: <strong>{RESOLUTION_LABEL[c.resolution]}</strong>
          {c.resolutionNote && <> — {c.resolutionNote}</>}
        </p>
      )}
      {c.status === 'DISMISSED' && <p className="mt-3 text-sm text-slate-600">The host dismissed this challenge{c.resolutionNote && <> — {c.resolutionNote}</>}.</p>}

      {c.responses.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-slate-700">
          {c.responses.map((r, i) => (
            <li key={i}>
              <span className="font-medium">{r.by}</span>{' '}
              {r.stance === 'OTHER'
                ? 'answered differently'
                : `${r.mine ? 'support' : 'supports'} the ${r.stance === 'ORIGINAL' ? 'original' : 'challenge'}`}
              {r.stance === 'OTHER' && r.answerRaw && <>: “{r.answerRaw}”</>}
              {r.comment && <span className="text-slate-500"> — {r.comment}</span>}
            </li>
          ))}
        </ul>
      )}

      {active && c.isParty && <p className="mt-3 text-xs text-slate-600">You are part of this challenge, so your side already counts.</p>}
      {active && c.myStance && <p className="mt-3 text-xs text-slate-600">You have responded. Each participant responds once.</p>}

      {c.canRespond && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" busy={busy === 'ORIGINAL'} disabled={!!busy} onClick={() => respond('ORIGINAL')}>
              Support original
            </Button>
            <Button variant="warning" size="sm" busy={busy === 'CHALLENGE'} disabled={!!busy} onClick={() => respond('CHALLENGE')}>
              Support challenge
            </Button>
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setOther((v) => !v)}>
              {hasAnswered ? 'Neither' : 'Submit different answer'}
            </Button>
          </div>
          {other && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void respond('OTHER');
              }}
            >
              <input
                className={inputClass}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                placeholder={hasAnswered ? 'Optional comment' : 'Your answer'}
                aria-label={hasAnswered ? 'Comment' : 'Your answer'}
                autoFocus
              />
              <Button type="submit" size="sm" busy={busy === 'OTHER'} disabled={!hasAnswered && !text.trim()}>
                Send
              </Button>
            </form>
          )}
          {hasAnswered && <p className="text-xs text-slate-500">Your own answer stays as you submitted it.</p>}
        </div>
      )}

      {c.canResolve && (
        <div className="mt-4 border-t border-amber-200 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Host decision</p>
          <input className={`${inputClass} mt-2`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Optional note for participants" aria-label="Resolution note" />
          <div className="mt-2 flex flex-wrap gap-2">
            {(Object.keys(RESOLUTION_LABEL) as ChallengeResolution[]).map((r) => (
              <Button key={r} variant="secondary" size="sm" busy={busy === r} disabled={!!busy} onClick={() => resolve(r)}>
                {RESOLUTION_LABEL[r]}
              </Button>
            ))}
            <Button variant="ghost" size="sm" busy={busy === 'DISMISSED'} disabled={!!busy} onClick={() => resolve('DISMISSED')}>
              Dismiss challenge
            </Button>
          </div>
        </div>
      )}
      <div className="mt-2">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </section>
  );
}
