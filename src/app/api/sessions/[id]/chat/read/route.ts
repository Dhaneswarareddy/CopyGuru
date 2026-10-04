import { readJson, requireAuth, route } from '@/lib/http/handler';

/** POST { channel: "public" | participantId, lastId } — marks a conversation read up to a message. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  const body = await readJson(req);
  return container.chat.markRead(session, participant, { channel: body.channel, lastId: body.lastId });
});
