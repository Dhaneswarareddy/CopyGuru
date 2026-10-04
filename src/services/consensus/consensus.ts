import type { Consensus, ConsensusGroup, ConsensusLevel } from '@/lib/domain/types';
import type { AnswerMatchingService } from '@/services/answerMatching';

export interface ConsensusThresholds {
  high: number;
  moderate: number;
  low: number;
}

export function consensusLevel(pct: number | null, t: ConsensusThresholds): ConsensusLevel {
  if (pct === null) return 'NONE';
  if (pct >= t.high) return 'HIGH_AGREEMENT';
  if (pct >= t.moderate) return 'MODERATE_AGREEMENT';
  if (pct >= t.low) return 'LOW_AGREEMENT';
  return 'HIGH_DISAGREEMENT';
}

export interface ConsensusInput {
  rawAnswer: string;
  normalizedAnswer: string;
  /** What this answer counts as (the endorsed answer when the participant agreed). */
  effectiveNormalized: string;
}

/**
 * Consensus = share of participants behind the most common answer. It measures
 * agreement between participants, NOT correctness.
 */
export function computeConsensus(
  answers: ConsensusInput[],
  matcher: AnswerMatchingService,
  thresholds: ConsensusThresholds,
): Consensus {
  const groups: (ConsensusGroup & { labelled: boolean })[] = [];
  for (const a of answers) {
    let group = groups.find((g) => g.key === a.effectiveNormalized || matcher.compare(g.key, a.effectiveNormalized).equivalent);
    if (!group) {
      group = { key: a.effectiveNormalized, label: a.effectiveNormalized, count: 0, pct: 0, labelled: false };
      groups.push(group);
    }
    group.count += 1;
    // label the group with the earliest answer that was literally typed that way
    if (!group.labelled && a.normalizedAnswer === a.effectiveNormalized) {
      group.label = a.rawAnswer.trim();
      group.labelled = true;
    }
  }
  const total = answers.length;
  const sorted = groups
    .map(({ labelled: _labelled, ...g }) => ({ ...g, pct: total ? Math.round((g.count / total) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);
  const pct = total ? Math.round((sorted[0].count / total) * 100) : null;
  return { total, pct, level: consensusLevel(pct, thresholds), groups: sorted };
}
