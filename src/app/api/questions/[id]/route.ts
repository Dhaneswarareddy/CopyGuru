import { requireAuth, route } from '@/lib/http/handler';

/** GET /api/questions/:id — detail view (answers, images, challenges, history). */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  return container.questions.detail(session, participant, params.id);
});
