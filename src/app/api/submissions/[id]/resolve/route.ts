import { readJson, requireAuth, route } from '@/lib/http/handler';
import type { MatchAction } from '@/services/submissions/submissionService';

/** POST { action: USE_EXISTING | CREATE_NEW | RETRY } — settle an uncertain or failed match. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  const body = await readJson(req);
  return container.submissions.resolveMatch(session, participant, params.id, body.action as MatchAction);
});
