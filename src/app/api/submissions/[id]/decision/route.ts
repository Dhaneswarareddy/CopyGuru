import { readJson, requireAuth, route } from '@/lib/http/handler';
import type { AnswerDecision } from '@/services/submissions/submissionService';

/** POST { decision: AGREE | CHALLENGE | KEEP, reason? } — after a match. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  const body = await readJson(req);
  return container.submissions.decide(
    session,
    participant,
    params.id,
    body.decision as AnswerDecision,
    typeof body.reason === 'string' ? body.reason : null,
  );
});
