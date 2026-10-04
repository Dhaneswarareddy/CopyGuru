import type { ConsensusLevel } from '@/lib/domain/types';
import type { AnswerTallyView, ConsensusView } from '@/lib/domain/views';
import { Badge } from '@/components/ui/Badge';

/** Agreement between participants — deliberately never labelled "correct". */
export const LEVEL_LABEL: Record<ConsensusLevel, string> = {
  HIGH_AGREEMENT: 'High agreement',
  MODERATE_AGREEMENT: 'Moderate agreement',
  LOW_AGREEMENT: 'Low agreement',
  HIGH_DISAGREEMENT: 'High disagreement',
  NONE: 'No answers yet',
};
const LEVEL_TONE: Record<ConsensusLevel, 'green' | 'indigo' | 'amber' | 'rose' | 'neutral'> = {
  HIGH_AGREEMENT: 'green',
  MODERATE_AGREEMENT: 'indigo',
  LOW_AGREEMENT: 'amber',
  HIGH_DISAGREEMENT: 'rose',
  NONE: 'neutral',
};

export function ConsensusBadge({ consensus }: { consensus: ConsensusView | null }) {
  if (!consensus || consensus.pct === null) return null;
  return (
    <Badge tone={LEVEL_TONE[consensus.level]} title="Share of participants who gave the most common answer">
      Consensus {consensus.pct}% · {LEVEL_LABEL[consensus.level]}
    </Badge>
  );
}

export function AnswerTally({ tally, max = 6 }: { tally: AnswerTallyView[]; max?: number }) {
  const shown = tally.slice(0, max);
  const rest = tally.slice(max).reduce((n, t) => n + t.count, 0);
  return (
    <ul className="space-y-1.5">
      {shown.map((t, i) => (
        <li key={`${t.label}-${i}`}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium text-slate-800">{t.label}</span>
            <span className="shrink-0 tabular-nums text-slate-600">
              {t.count} · {t.pct}%
            </span>
          </div>
          <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${i === 0 ? 'bg-linear-to-r from-violet-500 to-fuchsia-500' : 'bg-slate-400'}`} style={{ width: `${Math.max(t.pct, 2)}%` }} />
          </div>
        </li>
      ))}
      {rest > 0 && <li className="text-xs text-slate-500">+ {rest} more in other answers</li>}
    </ul>
  );
}
