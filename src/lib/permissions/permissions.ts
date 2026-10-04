import type { Role, SessionRow } from '@/lib/domain/types';
import { forbidden } from '@/lib/http/errors';

/**
 * Centralised permission system. Services ask `authorize(actor, session, X)`;
 * nothing else in the codebase checks roles directly. Adding a role means
 * adding one line to ROLE_PERMISSIONS.
 */
export enum Permission {
  CREATE_SESSION = 'CREATE_SESSION',
  START_SESSION = 'START_SESSION',
  END_SESSION = 'END_SESSION',
  POST_ANSWER = 'POST_ANSWER',
  CHALLENGE_ANSWER = 'CHALLENGE_ANSWER',
  RESPOND_TO_CHALLENGE = 'RESPOND_TO_CHALLENGE',
  RESOLVE_CHALLENGE = 'RESOLVE_CHALLENGE',
  VIEW_RESULTS = 'VIEW_RESULTS',
  VIEW_DASHBOARD = 'VIEW_DASHBOARD',
  /** See every answer regardless of the visibility setting. */
  VIEW_ALL_ANSWERS = 'VIEW_ALL_ANSWERS',
  /** See who gave each answer even when the session is anonymous. */
  VIEW_IDENTITIES = 'VIEW_IDENTITIES',
  USE_CHAT = 'USE_CHAT',
  /** Admit or decline people who asked to join from the public list. */
  ADMIT_PARTICIPANTS = 'ADMIT_PARTICIPANTS',
  REMOVE_PARTICIPANTS = 'REMOVE_PARTICIPANTS',
  MANAGE_SETTINGS = 'MANAGE_SETTINGS',
  /** Not subject to participant-level session restrictions. */
  BYPASS_SESSION_RESTRICTIONS = 'BYPASS_SESSION_RESTRICTIONS',
}

const P = Permission;
const PARTICIPANT = [P.POST_ANSWER, P.CHALLENGE_ANSWER, P.RESPOND_TO_CHALLENGE, P.VIEW_RESULTS, P.USE_CHAT];
const STAFF_VIEW = [P.VIEW_RESULTS, P.VIEW_DASHBOARD, P.VIEW_ALL_ANSWERS, P.VIEW_IDENTITIES];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  HOST: new Set(Object.values(Permission)),
  ADMIN: new Set(Object.values(Permission)),
  MODERATOR: new Set([...PARTICIPANT, ...STAFF_VIEW, P.RESOLVE_CHALLENGE, P.ADMIT_PARTICIPANTS, P.REMOVE_PARTICIPANTS, P.BYPASS_SESSION_RESTRICTIONS]),
  JUDGE: new Set([...STAFF_VIEW, P.RESOLVE_CHALLENGE, P.RESPOND_TO_CHALLENGE, P.USE_CHAT]),
  OBSERVER: new Set([P.VIEW_RESULTS, P.USE_CHAT]),
  PARTICIPANT: new Set(PARTICIPANT),
};

export interface Actor {
  id: string;
  role: Role;
}

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Session-setting policies layered on top of role permissions. Returning a
 * string denies the action with that explanation.
 */
type Policy = (actor: Actor, session: SessionRow) => string | null;
const POLICIES: Partial<Record<Permission, Policy>> = {
  [P.CHALLENGE_ANSWER]: (actor, session) => {
    if (!session.settings.challengeMode) return 'Challenges are disabled in this session';
    if (!session.settings.allowParticipantChallenges && !roleHas(actor.role, P.BYPASS_SESSION_RESTRICTIONS))
      return 'Only the host can open challenges in this session';
    return null;
  },
  [P.RESPOND_TO_CHALLENGE]: (_actor, session) =>
    session.settings.challengeMode ? null : 'Challenges are disabled in this session',
  // sessions created before chat existed have no chat keys: treat missing as enabled
  [P.USE_CHAT]: (_actor, session) => (session.settings.chatEnabled === false ? 'Chat is turned off in this session' : null),
  [P.VIEW_RESULTS]: () => null,
};

export function denialReason(actor: Actor, session: SessionRow, permission: Permission): string | null {
  if (!roleHas(actor.role, permission)) return 'You do not have permission to do that';
  return POLICIES[permission]?.(actor, session) ?? null;
}

export function can(actor: Actor, session: SessionRow, permission: Permission): boolean {
  return denialReason(actor, session, permission) === null;
}

export function authorize(actor: Actor, session: SessionRow, permission: Permission): void {
  const reason = denialReason(actor, session, permission);
  if (reason) throw forbidden(reason);
}
