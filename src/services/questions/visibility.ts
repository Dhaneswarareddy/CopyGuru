import type { ParticipantRow, SessionRow } from '@/lib/domain/types';
import { Permission, roleHas } from '@/lib/permissions/permissions';

export interface Visibility {
  /** May see what other participants answered for this question. */
  answers: boolean;
  consensus: boolean;
  identities: boolean;
}

/** Single place that turns session settings + role into what a viewer may see. */
export function visibilityFor(session: SessionRow, viewer: ParticipantRow, answeredByViewer: boolean): Visibility {
  const mode = session.settings.previousAnswerVisibility;
  return {
    answers:
      roleHas(viewer.role, Permission.VIEW_ALL_ANSWERS) ||
      mode === 'BEFORE_ANSWER' ||
      (mode === 'AFTER_ANSWER' && answeredByViewer),
    consensus: roleHas(viewer.role, Permission.VIEW_DASHBOARD) || session.settings.showConsensus,
    identities: roleHas(viewer.role, Permission.VIEW_IDENTITIES) || !session.settings.anonymousAnswers,
  };
}

/** Resolves display names for a viewer, honouring anonymous mode. */
export function nameResolver(
  viewer: ParticipantRow,
  participants: Map<string, ParticipantRow>,
  identitiesVisible: boolean,
  anonymousLabel = 'Anonymous',
) {
  return (participantId: string | null | undefined): string => {
    if (!participantId) return 'Unknown';
    if (participantId === viewer.id) return 'You';
    if (!identitiesVisible) return anonymousLabel;
    return participants.get(participantId)?.displayName ?? 'Former participant';
  };
}
