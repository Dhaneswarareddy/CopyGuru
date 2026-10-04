import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings } from '@/lib/domain/settings';
import type { SessionRow } from '@/lib/domain/types';
import { Permission, can, roleHas } from '@/lib/permissions/permissions';
import { generateSessionCode, generateToken, hashToken, signImage, verifyImageSignature } from '@/lib/auth/tokens';
import { CHALLENGE_TRANSITIONS, assertTransition, canTransition, isActive } from '@/services/challenges/stateMachine';
import { classifyMatch } from '@/services/imageSimilarity';

const T = { highThreshold: 0.86, possibleThreshold: 0.66 };
const match = (similarity: number, questionId = 'q') => ({ questionId, imageId: 'i', similarity });

describe('three-state match decision', () => {
  it('returns NO_MATCH when there are no candidates', () => {
    expect(classifyMatch([], T)).toEqual({ decision: 'NO_MATCH', best: null });
  });
  it('classifies by the best candidate', () => {
    expect(classifyMatch([match(0.91)], T).decision).toBe('HIGH_MATCH');
    expect(classifyMatch([match(0.72)], T).decision).toBe('POSSIBLE_MATCH');
    expect(classifyMatch([match(0.32)], T).decision).toBe('NO_MATCH');
    expect(classifyMatch([match(0.4, 'x'), match(0.9, 'y'), match(0.7, 'z')], T).best?.questionId).toBe('y');
  });
  it('treats thresholds as inclusive lower bounds', () => {
    expect(classifyMatch([match(0.86)], T).decision).toBe('HIGH_MATCH');
    expect(classifyMatch([match(0.66)], T).decision).toBe('POSSIBLE_MATCH');
    expect(classifyMatch([match(0.6599)], T).decision).toBe('NO_MATCH');
  });
});

describe('challenge state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('OPEN', 'DISCUSSION')).toBe(true);
    expect(canTransition('OPEN', 'RESOLVED')).toBe(true);
    expect(canTransition('DISCUSSION', 'DISMISSED')).toBe(true);
    expect(canTransition('DISCUSSION', 'OPEN')).toBe(false);
    expect(CHALLENGE_TRANSITIONS.RESOLVED).toEqual([]);
    expect(CHALLENGE_TRANSITIONS.DISMISSED).toEqual([]);
    expect(() => assertTransition('RESOLVED', 'DISCUSSION')).toThrow(/cannot become/);
    expect(isActive('OPEN') && isActive('DISCUSSION') && !isActive('RESOLVED') && !isActive('DISMISSED')).toBe(true);
  });
});

const session = (settings = {}) => ({ settings: { ...defaultSettings(), ...settings } }) as SessionRow;

describe('permissions', () => {
  it('gives hosts everything and participants only participant actions', () => {
    expect(roleHas('HOST', Permission.RESOLVE_CHALLENGE)).toBe(true);
    expect(roleHas('PARTICIPANT', Permission.POST_ANSWER)).toBe(true);
    expect(roleHas('PARTICIPANT', Permission.RESOLVE_CHALLENGE)).toBe(false);
    expect(roleHas('PARTICIPANT', Permission.START_SESSION)).toBe(false);
    expect(roleHas('PARTICIPANT', Permission.VIEW_DASHBOARD)).toBe(false);
    expect(roleHas('OBSERVER', Permission.POST_ANSWER)).toBe(false);
    expect(roleHas('JUDGE', Permission.RESOLVE_CHALLENGE)).toBe(true);
  });
  it('applies session-setting policies on top of roles', () => {
    const p = { id: 'p', role: 'PARTICIPANT' as const };
    const h = { id: 'h', role: 'HOST' as const };
    expect(can(p, session(), Permission.CHALLENGE_ANSWER)).toBe(true);
    expect(can(p, session({ challengeMode: false }), Permission.CHALLENGE_ANSWER)).toBe(false);
    expect(can(h, session({ challengeMode: false }), Permission.CHALLENGE_ANSWER)).toBe(false);
    expect(can(p, session({ allowParticipantChallenges: false }), Permission.CHALLENGE_ANSWER)).toBe(false);
    expect(can(h, session({ allowParticipantChallenges: false }), Permission.CHALLENGE_ANSWER)).toBe(true);
  });
});

describe('settings & tokens', () => {
  it('falls back to defaults for unknown or invalid settings', () => {
    const s = parseSettings({ previousAnswerVisibility: 'NEVER', challengeMode: 'yes', evil: true, anonymousAnswers: true });
    expect(s.previousAnswerVisibility).toBe('NEVER');
    expect(s.challengeMode).toBe(true);
    expect(s.anonymousAnswers).toBe(true);
    expect('evil' in s).toBe(false);
    expect(parseSettings(null)).toEqual(defaultSettings());
  });
  it('generates unguessable tokens, readable codes and verifiable image signatures', () => {
    expect(generateToken()).not.toBe(generateToken());
    expect(hashToken('x')).toHaveLength(64);
    expect(generateSessionCode()).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
    const sig = signImage('secret', 'img-1');
    expect(verifyImageSignature('secret', 'img-1', sig)).toBe(true);
    expect(verifyImageSignature('secret', 'img-2', sig)).toBe(false);
    expect(verifyImageSignature('other', 'img-1', sig)).toBe(false);
    expect(verifyImageSignature('secret', 'img-1', null)).toBe(false);
  });
});
