import { requireAuth, route } from '@/lib/http/handler';

/** GET /api/sessions/:id/chat — what chat the viewer has and what is unread. */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  return container.chat.overview(session, participant);
});
