import { readJson, requireAuth, route } from '@/lib/http/handler';

/** POST { answer } — answer an existing question without uploading an image. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  const body = await readJson(req);
  return container.questions.answerDirect(session, participant, params.id, body.answer);
});
