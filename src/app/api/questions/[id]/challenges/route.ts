import { readJson, requireAuth, route } from '@/lib/http/handler';

/** POST { reason?, answer? } — challenge the question's original answer. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  const body = await readJson(req);
  await container.challenges.create(session, participant, params.id, { reason: body.reason, answer: body.answer });
  return container.questions.detail(session, participant, params.id);
});
