import { readJson, requireAuth, route } from '@/lib/http/handler';

/** POST { settings } — a host changes settings while the session is running. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  const body = await readJson(req);
  return { session: container.sessions.toSessionView(await container.sessions.updateSettings(session, participant, body.settings)) };
});
