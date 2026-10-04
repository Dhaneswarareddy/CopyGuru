import { requireAuth, route } from '@/lib/http/handler';

export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  return { session: container.sessions.toSessionView(await container.sessions.end(session, participant)) };
});
