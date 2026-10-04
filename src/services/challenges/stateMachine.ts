import type { ChallengeResolution, ChallengeStatus } from '@/lib/domain/types';
import { conflict } from '@/lib/http/errors';

/**
 * Challenge lifecycle:
 *
 *   OPEN ──(first response)──▶ DISCUSSION ──▶ RESOLVED
 *     │                            │
 *     └────────────┬───────────────┘
 *                  ▼
 *        RESOLVED | DISMISSED   (terminal)
 */
export const CHALLENGE_TRANSITIONS: Record<ChallengeStatus, readonly ChallengeStatus[]> = {
  OPEN: ['DISCUSSION', 'RESOLVED', 'DISMISSED'],
  DISCUSSION: ['RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
};

export const RESOLUTIONS: readonly ChallengeResolution[] = [
  'ORIGINAL_ACCEPTED',
  'CHALLENGE_ACCEPTED',
  'BOTH_VALID',
  'UNRESOLVED',
];

export const isActive = (status: ChallengeStatus) => status === 'OPEN' || status === 'DISCUSSION';

export function canTransition(from: ChallengeStatus, to: ChallengeStatus) {
  return CHALLENGE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ChallengeStatus, to: ChallengeStatus) {
  if (!canTransition(from, to))
    throw conflict(`A challenge that is ${from} cannot become ${to}`, 'INVALID_CHALLENGE_TRANSITION');
}
