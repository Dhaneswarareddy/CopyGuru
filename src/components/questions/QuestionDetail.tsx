'use client';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage } from '@/lib/client/api';
import type { AnswerRelationship } from '@/lib/domain/types';
import type { QuestionDetailView } from '@/lib/domain/views';
import { ChallengePanel } from '@/components/challenges/ChallengePanel';
import { clock, timeAgo } from '@/components/notifications/NotificationBell';
import { useLiveReload, useSession } from '@/components/session/SessionProvider';
import { Badge, Card, ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button, Spinner } from '@/components/ui/Button';
import { ImageViewer, type ViewerImage } from '@/components/ui/ImageViewer';
import { AnswerTally, ConsensusBadge } from './ConsensusMeter';
import { StatusBadges } from './QuestionCard';

const RELATIONSHIP_LABEL: Record<AnswerRelationship, string | null> = {
  ORIGINAL: 'original answer',
  AGREES: 'agrees',
  CHALLENGES: 'challenged',
  INDEPENDENT: null,
  UNDECIDED: 'deciding…',
};

export function QuestionDetail({ questionId }: { questionId: string }) {
  const { call, openQuestion } = useSession();
  const [detail, setDetail] = useState<QuestionDetailView | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  /** The image shown large on the page (chosen from the strip). */
  const [selected, setSelected] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const closeViewer = useCallback(() => setViewerOpen(false), []);

  const load = useCallback(async () => {
    try {
      setDetail(await call<QuestionDetailView>(`/api/questions/${questionId}`));
      setError(null);
    } catch (err) {
      setError({ message: errorMessage(err), missing: err instanceof ApiError && err.status === 404 });
    }
  }, [call, questionId]);

  useEffect(() => {
    void load();
  }, [load]);
  useLiveReload(load, (e) => e.questionId === questionId || e.type === 'RESYNC' || e.type === 'SESSION_ENDED');

  const back = (
    <button type="button" onClick={() => openQuestion(null)} className="text-sm font-medium text-indigo-600 hover:underline">
      ← Back
    </button>
  );

  if (!detail)
    return (
      <div className="space-y-4">
        {back}
        {error ? (
          <Card className="space-y-3 p-6 text-center">
            <ErrorNote>{error.missing ? 'This question does not exist in this session.' : error.message}</ErrorNote>
            {!error.missing && <Button onClick={() => void load()}>Try again</Button>}
          </Card>
        ) : (
          <div className="flex justify-center py-10 text-indigo-600">
            <Spinner className="h-6 w-6" />
          </div>
        )}
      </div>
    );

  const d = detail;
  const main = selected ?? d.displayUrl;
  const gallery: ViewerImage[] = d.images.length
    ? d.images.map((img) => ({ url: img.displayUrl, alt: `Question ${d.number}, image from ${img.by}`, caption: `Question #${d.number} · ${img.by}` }))
    : main
      ? [{ url: main, alt: `Question ${d.number}` }]
      : [];
  const others = d.answers?.filter((a) => !a.mine) ?? [];

  return (
    <article className="space-y-4">
      <div className="flex items-center justify-between">
        {back}
        <span className="text-xs text-slate-500">Updates live</span>
      </div>

      <Card className="overflow-hidden">
        {main && (
          <button type="button" onClick={() => setViewerOpen(true)} aria-label="Open image full screen to zoom" className="relative block w-full cursor-zoom-in">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={main} alt={`Question ${d.number}`} className="max-h-[26rem] w-full bg-black object-contain" />
            <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-2 py-1 text-xs text-onaccent">Tap to zoom</span>
          </button>
        )}
        {viewerOpen && gallery.length > 0 && (
          <ImageViewer images={gallery} index={Math.max(0, gallery.findIndex((g) => g.url === main))} onClose={closeViewer} />
        )}
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Question #{d.number}</h2>
            <StatusBadges q={d} />
            <ConsensusBadge consensus={d.consensus} />
          </div>
          {d.images.length > 1 && (
            <div>
              <p className="mb-1.5 text-xs text-slate-500">
                {d.imageCount} images were recognised as this same question. Tap one to show it above.
              </p>
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {d.images.map((img) => (
                  <li key={img.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => setSelected(img.displayUrl)}
                      className={`block overflow-hidden rounded-lg ring-2 ${main === img.displayUrl ? 'ring-indigo-500' : 'ring-transparent hover:ring-slate-300'}`}
                      title={`${img.by}${img.similarity !== null && !img.isRepresentative ? ` · similarity ${img.similarity.toFixed(2)}` : ''}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.thumbUrl} alt={`Image from ${img.by}`} loading="lazy" className="h-16 w-16 object-cover" />
                    </button>
                    <p className="mt-0.5 w-16 truncate text-center text-[11px] text-slate-500">{img.by}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>

      {d.challenges.map((c) => (
        <ChallengePanel key={c.id} challenge={c} hasAnswered={d.answeredByMe} onChange={setDetail} />
      ))}
      {!d.caps.canSeeAnswers && d.openChallengeCount > 0 && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          ⚠️ An answer to this question has been challenged. {d.answeredByMe ? '' : 'Submit your answer to see both sides.'}
        </p>
      )}

      <Card className="space-y-4 p-4">
        {d.originalAnswer && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Original answer · {d.originalAnswer.by}</p>
            <p className="mt-0.5 break-words text-base font-semibold text-slate-900">{d.originalAnswer.raw}</p>
          </div>
        )}
        {d.tally && d.tally.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
              What participants answered ({d.answerCount})
            </p>
            <AnswerTally tally={d.tally} />
            <p className="mt-2 text-xs text-slate-500">Consensus shows agreement between participants, not which answer is right.</p>
          </div>
        )}
        {!d.caps.canSeeAnswers && (
          <p className="text-sm text-slate-600">
            {d.answeredByMe
              ? 'Other participants’ answers are hidden in this session.'
              : `${d.answerCount} ${d.answerCount === 1 ? 'participant has' : 'participants have'} answered. Submit yours to see what they said.`}
          </p>
        )}

        <MyAnswer detail={d} onChange={setDetail} />
      </Card>

      {d.caps.canSeeAnswers && others.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">All answers</h3>
          <ul className="divide-y divide-slate-100">
            {d.answers!.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-sm">
                <span className="font-medium text-slate-900">{a.by}</span>
                <span className="break-words text-slate-800">“{a.raw}”</span>
                {RELATIONSHIP_LABEL[a.relationship] && (
                  <Badge tone={a.relationship === 'CHALLENGES' ? 'amber' : 'neutral'}>
                    {RELATIONSHIP_LABEL[a.relationship]}
                    {a.relationship === 'AGREES' && a.endorsedRaw && a.endorsedRaw !== a.raw ? ` with “${a.endorsedRaw}”` : ''}
                  </Badge>
                )}
                <span className="ml-auto text-xs text-slate-400">{timeAgo(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.history && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Full history (host only)</h3>
          <ol className="space-y-1.5 text-sm">
            {d.history.map((e) => (
              <li key={e.id} className="flex gap-3">
                <time className="shrink-0 whitespace-nowrap pt-0.5 text-xs tabular-nums text-slate-400" dateTime={e.createdAt}>
                  {clock(e.createdAt)}
                </time>
                <span className="text-slate-700">{e.summary}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </article>
  );
}

/** The viewer's own answer: submit one, or see it and optionally challenge. */
function MyAnswer({ detail: d, onChange }: { detail: QuestionDetailView; onChange(d: QuestionDetailView): void }) {
  const { call } = useSession();
  const [answer, setAnswer] = useState('');
  const [reason, setReason] = useState('');
  const [challenging, setChallenging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(path: string, json: unknown) {
    setBusy(true);
    setError(null);
    try {
      onChange(await call<QuestionDetailView>(path, { json }));
      setChallenging(false);
      setAnswer('');
      setReason('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const mine = d.answers?.find((a) => a.mine);
  const needsAnswerToChallenge = !d.answeredByMe;

  return (
    <div className="border-t border-slate-100 pt-4">
      {mine ? (
        <p className="text-sm text-slate-700">
          Your answer: <strong className="break-words text-slate-900">“{mine.raw}”</strong>
          {mine.relationship === 'AGREES' && mine.endorsedRaw && mine.endorsedRaw !== mine.raw && (
            <span className="text-slate-500"> — you agreed with “{mine.endorsedRaw}”</span>
          )}
        </p>
      ) : d.caps.canAnswer ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(`/api/questions/${d.id}/answers`, { answer });
          }}
        >
          <label htmlFor="direct-answer" className="block text-sm font-medium text-slate-800">
            Your answer
          </label>
          <div className="flex gap-2">
            <input id="direct-answer" className={inputClass} value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={500} placeholder="What is this?" />
            <Button type="submit" busy={busy && !challenging} disabled={!answer.trim() || busy}>
              Submit my answer
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-slate-500">You have not answered this question.</p>
      )}

      {d.caps.canChallenge && !challenging && (
        <Button variant="warning" size="sm" className="mt-3" onClick={() => setChallenging(true)}>
          Challenge the original answer
        </Button>
      )}
      {challenging && (
        <form
          className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(`/api/questions/${d.id}/challenges`, needsAnswerToChallenge ? { answer, reason } : { reason });
          }}
        >
          <p className="text-sm font-medium text-slate-900">
            Challenge “{d.originalAnswer?.raw}”{mine ? <> with your answer “{mine.raw}”</> : null}
          </p>
          {needsAnswerToChallenge && (
            <input className={inputClass} value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={500} placeholder="Your answer" aria-label="Your answer" />
          )}
          <textarea className={inputClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Reason (optional)" aria-label="Reason (optional)" />
          <p className="text-xs text-slate-600">Everyone in the session will be notified. Both answers stay on record.</p>
          <div className="flex gap-2">
            <Button type="submit" variant="warning" size="sm" busy={busy} disabled={needsAnswerToChallenge && !answer.trim()}>
              Challenge answer
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setChallenging(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="mt-2">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </div>
  );
}
