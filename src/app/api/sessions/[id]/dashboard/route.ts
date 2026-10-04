import { requireAuth, route } from '@/lib/http/handler';

/** GET /api/sessions/:id/dashboard — host overview (requires VIEW_DASHBOARD). */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  return container.sessions.dashboard(session, participant);
});
