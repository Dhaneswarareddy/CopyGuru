import { readJson, requireAuth, route } from '@/lib/http/handler';

/** POST { stance: ORIGINAL | CHALLENGE | OTHER, answer?, comment? } */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  const body = await readJson(req);
  return container.challenges.respond(session, participant, params.id, {
    stance: body.stance,
    answer: body.answer,
    comment: body.comment,
  });
});
