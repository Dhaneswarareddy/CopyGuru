'use client';
import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import type { QuestionSummaryView, SubmissionResult } from '@/lib/domain/views';
import { useSession } from '@/components/session/SessionProvider';
import { Card, ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ZoomableImage } from '@/components/ui/ImageViewer';
import { ImageInput, type PickedImage } from './ImageInput';
import { MatchDialog } from './MatchDialog';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** Tab 1 — post an image with your answer. */
export function PlayTab() {
  const { state, call, code, openQuestion, refresh, setTab } = useSession();
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a submission that still needs a decision; restored from the server after a refresh
  const [dialog, setDialog] = useState<Exclude<SubmissionResult, { outcome: 'NEW_QUESTION' }> | null>(
    state.pending && state.pending.outcome !== 'NEW_QUESTION' ? state.pending : null,
  );
  const [created, setCreated] = useState<QuestionSummaryView | null>(null);
  const [recorded, setRecorded] = useState<QuestionSummaryView | null>(null);

  useEffect(() => {
    if (!picked) return setPreview(null);
    const url = URL.createObjectURL(picked.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  function pick(image: PickedImage) {
    setError(null);
    setCreated(null);
    setRecorded(null);
    if (image.file.type && !ACCEPTED.includes(image.file.type)) return setError('Please choose a JPEG, PNG, WebP, GIF or AVIF image.');
    if (image.file.size > state.limits.maxImageBytes)
      return setError(`That image is too large (max ${Math.round(state.limits.maxImageBytes / 1024 / 1024)} MB).`);
    setPicked(image);
  }

  function handle(result: SubmissionResult) {
    if (result.outcome === 'NEW_QUESTION') {
      setDialog(null);
      setCreated(result.question);
    } else {
      setDialog(result);
      // a completed decision (agree / challenge / keep) leaves nothing to ask
      if (result.outcome === 'MATCHED' && !result.prompt.needsDecision) setRecorded(result.question);
    }
  }

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!picked || !answer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('image', picked.file);
      form.set('answer', answer);
      form.set('source', picked.source);
      const result = await call<SubmissionResult>(`/api/sessions/${code}/submissions`, { form });
      setPicked(null);
      setAnswer('');
      handle(result);
    } catch (err) {
      setError(errorMessage(err)); // the image and answer stay in the form for another try
    } finally {
      setBusy(false);
    }
  }

  if (!state.caps.canPost)
    return (
      <Card className="p-8 text-center text-sm text-slate-600">
        {state.session.status === 'ENDED' ? 'This session has ended, so new answers are closed.' : 'Your role in this session cannot post answers.'}
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setTab('questions')}>
            Browse the questions
          </Button>
        </div>
      </Card>
    );

  return (
    <section aria-label="Post an answer" className="space-y-4">
      {created && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4">
          <p className="flex-1 text-sm text-emerald-900">
            <strong>Question #{created.number} created.</strong> No similar question existed, so yours is the first answer.
          </p>
          <Button size="sm" variant="secondary" onClick={() => openQuestion(created.id)}>
            View question
          </Button>
        </div>
      )}
      {recorded && !dialog && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <p className="flex-1 text-sm text-indigo-900">
            Your answer was added to <strong>Question #{recorded.number}</strong>.
          </p>
          <Button size="sm" variant="secondary" onClick={() => openQuestion(recorded.id)}>
            View question
          </Button>
        </div>
      )}

      <Card className="p-4 sm:p-6">
        <form onSubmit={post} className="space-y-4">
          <div className="flex min-h-56 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50">
            {preview ? (
              <ZoomableImage image={{ url: preview, alt: 'Your selected image' }} className="max-h-80 w-full object-contain" />
            ) : (
              <p className="px-6 py-10 text-center text-sm text-slate-500">
                Add a picture of the question.
                <br />
                If someone already posted the same content — even as a different photo — you&apos;ll see their answer.
              </p>
            )}
          </div>
          <ImageInput isDemo={state.session.isDemo} disabled={busy} onPick={pick} onError={setError} />

          <div>
            <label htmlFor="answer" className="mb-1 block text-sm font-medium text-slate-800">
              Your answer
            </label>
            <textarea
              id="answer"
              className={inputClass}
              rows={2}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={state.limits.maxAnswerLength}
              placeholder="Type your answer"
              disabled={busy}
            />
          </div>
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" size="lg" block busy={busy} disabled={!picked || !answer.trim()}>
            {busy ? 'Checking for an existing question…' : 'Post answer'}
          </Button>
          {(!picked || !answer.trim()) && !busy && (
            <p className="text-center text-xs text-slate-500">{!picked ? 'Add an image to post.' : 'Type an answer to post.'}</p>
          )}
        </form>
      </Card>

      {dialog && (
        <MatchDialog
          result={dialog}
          onResult={handle}
          onDone={() => {
            setDialog(null);
            void refresh(); // clears the server-side "pending" marker from local state
          }}
        />
      )}
    </section>
  );
}
