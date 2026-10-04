import { requireAuth, route } from '@/lib/http/handler';

/** GET /api/sessions/:id — session state for the authenticated participant. */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  return container.sessions.state(session, participant);
});
