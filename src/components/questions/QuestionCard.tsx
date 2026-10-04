import type { QuestionSummaryView } from '@/lib/domain/views';
import { Badge } from '@/components/ui/Badge';
import { AnswerTally, ConsensusBadge } from './ConsensusMeter';

export function StatusBadges({ q }: { q: Pick<QuestionSummaryView, 'status' | 'openChallengeCount'> }) {
  if (q.status === 'CHALLENGED')
    return (
      <Badge tone="amber">
        ⚠️ Challenged{q.openChallengeCount > 1 ? ` ×${q.openChallengeCount}` : ''}
      </Badge>
    );
  if (q.status === 'RESOLVED') return <Badge tone="green">✓ Challenge resolved</Badge>;
  return null;
}

export function QuestionCard({ q, onOpen }: { q: QuestionSummaryView; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full gap-4 rounded-xl border bg-white p-3 text-left transition-shadow hover:shadow-md ${
        q.status === 'CHALLENGED' ? 'border-amber-300' : 'border-slate-200'
      }`}
    >
      {q.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={q.thumbUrl} alt={`Question ${q.number}`} loading="lazy" className="h-24 w-24 shrink-0 rounded-lg bg-slate-100 object-cover sm:h-28 sm:w-28" />
      ) : (
        <div className="h-24 w-24 shrink-0 rounded-lg bg-slate-100" />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Question #{q.number}</h3>
          <StatusBadges q={q} />
          <span className="text-xs text-slate-500">
            {q.answerCount} {q.answerCount === 1 ? 'answer' : 'answers'} · {q.imageCount} {q.imageCount === 1 ? 'image' : 'images'}
          </span>
        </div>
        {q.tally ? (
          <AnswerTally tally={q.tally} max={3} />
        ) : (
          <p className="text-sm text-slate-500">
            {q.answeredByMe ? 'Other answers are hidden in this session.' : 'Answer this question to see what others said.'}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ConsensusBadge consensus={q.consensus} />
          {q.answeredByMe ? <Badge>You: {q.myAnswer}</Badge> : <Badge tone="indigo">Not answered by you</Badge>}
        </div>
      </div>
    </button>
  );
}
