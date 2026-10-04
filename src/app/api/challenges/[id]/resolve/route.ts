import { readJson, requireAuth, route } from '@/lib/http/handler';

/** POST { outcome: ORIGINAL_ACCEPTED | CHALLENGE_ACCEPTED | BOTH_VALID | UNRESOLVED | DISMISSED, note? } */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  const body = await readJson(req);
  return container.challenges.resolve(session, participant, params.id, { outcome: body.outcome, note: body.note });
});
