import { readJson, route } from '@/lib/http/handler';
import { clientIp, rateLimit } from '@/lib/http/rateLimit';

/** POST /api/sessions/:id/join — join by session code (or id). */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  rateLimit(`join:${clientIp(req)}`, 60, 60_000);
  const body = await readJson(req);
  const { session, participant, token } = await container.sessions.join(params.id, { displayName: body.displayName });
  return { session: container.sessions.toSessionView(session), participantId: participant.id, token };
});
