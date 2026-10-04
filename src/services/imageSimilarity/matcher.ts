import type { MatchVerdict, SimilarityMatch } from './types';

export interface MatchThresholds {
  highThreshold: number;
  possibleThreshold: number;
}

/**
 * Three-state decision. Auto-grouping happens only above the high threshold;
 * the band in between is "uncertain" and is settled by asking the participant.
 */
export function classifyMatch(matches: SimilarityMatch[], t: MatchThresholds): MatchVerdict {
  const best = matches.reduce<SimilarityMatch | null>((b, m) => (!b || m.similarity > b.similarity ? m : b), null);
  if (!best || best.similarity < t.possibleThreshold) return { decision: 'NO_MATCH', best };
  if (best.similarity >= t.highThreshold) return { decision: 'HIGH_MATCH', best };
  return { decision: 'POSSIBLE_MATCH', best };
}
