import { readJson, requireAuth, route } from '@/lib/http/handler';

export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { participant } = await requireAuth(req, container, params.id);
  return container.notifications.list(participant);
});

/** POST { ids?: string[] } — marks the given (or all) notifications as read. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { participant } = await requireAuth(req, container, params.id);
  const body = await readJson(req);
  return container.notifications.markRead(participant, body.ids ?? null);
});
