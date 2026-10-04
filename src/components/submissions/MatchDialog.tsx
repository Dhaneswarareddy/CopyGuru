'use client';
import { useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import type { SubmissionResult } from '@/lib/domain/views';
import { useSession } from '@/components/session/SessionProvider';
import { ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ZoomableImage, type ViewerImage } from '@/components/ui/ImageViewer';
import { Modal } from '@/components/ui/Modal';

interface Props {
  result: Exclude<SubmissionResult, { outcome: 'NEW_QUESTION' }>;
  /** Called with the next state of the submission (it may need another step). */
  onResult(result: SubmissionResult): void;
  onDone(): void;
}

function Quote({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 break-words text-base font-semibold text-slate-900">{children}</p>
    </div>
  );
}

/**
 * Everything that can happen after posting an image that was not simply a new
 * question: uncertain match, existing question (agree / challenge / keep),
 * similarity unavailable, or already answered.
 */
export function MatchDialog({ result, onResult, onDone }: Props) {
  const { call, openQuestion } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [challenging, setChallenging] = useState(false);
  const [reason, setReason] = useState('');

  async function act(key: string, path: string, json: unknown) {
    setBusy(key);
    setError(null);
    try {
      onResult(await call<SubmissionResult>(path, { json }));
      setChallenging(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  const resolve = (action: string) => act(action, `/api/submissions/${result.submissionId}/resolve`, { action });
  const decide = (decision: string) => act(decision, `/api/submissions/${result.submissionId}/decision`, { decision, reason });
  const view = (questionId: string) => {
    onDone();
    openQuestion(questionId);
  };

  if (result.outcome === 'SIMILARITY_UNAVAILABLE')
    return (
      <Modal title="Couldn't check for a match" tone="warning">
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            We couldn&apos;t determine whether this question already exists. Your image and answer are saved; nothing was grouped automatically.
          </p>
          <Quote label="Your answer">{result.yourAnswer}</Quote>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button block busy={busy === 'RETRY'} disabled={!!busy} onClick={() => resolve('RETRY')}>
              Try again
            </Button>
            <Button block variant="secondary" busy={busy === 'CREATE_NEW'} disabled={!!busy} onClick={() => resolve('CREATE_NEW')}>
              Create new question
            </Button>
          </div>
        </div>
      </Modal>
    );

  if (result.outcome === 'POSSIBLE_MATCH') {
    const pair: ViewerImage[] = [
      { url: result.yourImageUrl, alt: 'Your image', caption: 'Your image' },
      ...(result.candidate.imageUrl
        ? [{ url: result.candidate.imageUrl, alt: `Question ${result.candidate.number}`, caption: `Question #${result.candidate.number}` }]
        : []),
    ];
    return (
      <Modal title="Possible match">
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            We found a potentially related question. Is this the same question/content as <strong>Question #{result.candidate.number}</strong>?
          </p>
          <div className="grid grid-cols-2 gap-3">
            {pair.map((i) => (
              <figure key={i.url}>
                <ZoomableImage image={i} gallery={pair} className="h-36 w-full rounded-lg bg-slate-100 object-cover" />
                <figcaption className="mt-1 text-center text-xs text-slate-600">{i.caption}</figcaption>
              </figure>
            ))}
          </div>
          <p className="text-center text-xs text-slate-500">
            Similarity {result.similarity.toFixed(2)} — not confident enough to decide for you. Tap an image to zoom in.
          </p>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex flex-col gap-2">
            <Button block busy={busy === 'USE_EXISTING'} disabled={!!busy} onClick={() => resolve('USE_EXISTING')}>
              Yes, use existing
            </Button>
            <Button block variant="secondary" busy={busy === 'CREATE_NEW'} disabled={!!busy} onClick={() => resolve('CREATE_NEW')}>
              No, create new question
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  if (result.outcome === 'ALREADY_ANSWERED')
    return (
      <Modal title="Already answered" onClose={onDone}>
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            This content is <strong>Question #{result.question.number}</strong>, which you have already answered. Your new image was added to it; your answer stays as it was.
          </p>
          <Quote label="Your answer on record">{result.yourAnswer}</Quote>
          <div className="flex gap-2">
            <Button block onClick={() => view(result.question.id)}>
              View question
            </Button>
            <Button block variant="secondary" onClick={onDone}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );

  // outcome === 'MATCHED'
  const { prompt, question } = result;
  const header = (
    <p className="text-sm text-slate-700">
      This content has already been posted as <strong>Question #{question.number}</strong>
      {result.similarity !== null && <span className="text-slate-500"> (image similarity {result.similarity.toFixed(2)})</span>}. Your image and answer
      were added to it.
    </p>
  );

  if (!prompt.needsDecision)
    return (
      <Modal title="🔎 Match found" onClose={onDone}>
        <div className="space-y-4">
          {header}
          {prompt.previousAnswer && <Quote label={`Previous answer · ${prompt.previousAnswer.by}`}>{prompt.previousAnswer.raw}</Quote>}
          <Quote label="Your answer">{prompt.yourAnswer}</Quote>
          <p className="text-sm text-slate-700">
            {prompt.sameAnswer
              ? 'You gave the same answer, so it was recorded as agreeing.'
              : prompt.previousAnswer
                ? 'Your choice has been recorded.'
                : 'Other answers are hidden in this session. Your answer has been recorded.'}
          </p>
          <div className="flex gap-2">
            <Button block onClick={() => view(question.id)}>
              View question
            </Button>
            <Button block variant="secondary" onClick={onDone}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title="🔎 This question already exists">
      <div className="space-y-4">
        {header}
        {prompt.previousAnswer && <Quote label={`Previous answer · ${prompt.previousAnswer.by}`}>{prompt.previousAnswer.raw}</Quote>}
        <Quote label="Your answer">{prompt.yourAnswer}</Quote>
        <ErrorNote>{error}</ErrorNote>

        {challenging ? (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <label htmlFor="challenge-reason" className="block text-sm font-medium text-slate-900">
              Why do you disagree? <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <textarea id="challenge-reason" className={inputClass} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="This looks more like…" autoFocus />
            <p className="text-xs text-slate-600">Everyone in the session will be notified. Both answers stay on record.</p>
            <div className="flex gap-2">
              <Button variant="warning" block busy={busy === 'CHALLENGE'} disabled={!!busy} onClick={() => decide('CHALLENGE')}>
                Challenge answer
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => setChallenging(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-900">Do you agree with the previous answer?</p>
            <div className="flex flex-col gap-2">
              <Button block busy={busy === 'AGREE'} disabled={!!busy} onClick={() => decide('AGREE')}>
                Agree
              </Button>
              {prompt.canChallenge && (
                <Button block variant="warning" disabled={!!busy} onClick={() => setChallenging(true)}>
                  Challenge this answer
                </Button>
              )}
              <Button block variant="secondary" busy={busy === 'KEEP'} disabled={!!busy} onClick={() => decide('KEEP')}>
                Keep my answer without challenge
              </Button>
            </div>
            <p className="text-xs text-slate-500">Whatever you choose, your answer “{prompt.yourAnswer}” is kept exactly as you wrote it.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
