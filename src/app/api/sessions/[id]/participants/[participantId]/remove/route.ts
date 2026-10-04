import { requireAuth, route } from '@/lib/http/handler';

/** POST — a host removes someone from the session. Returns the remaining participants. */
export const POST = route<{ id: string; participantId: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  return { participants: await container.sessions.removeParticipant(session, participant, params.participantId) };
});
