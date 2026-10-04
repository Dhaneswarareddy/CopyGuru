import { readJson, route } from '@/lib/http/handler';
import { clientIp, rateLimit } from '@/lib/http/rateLimit';

/** GET /api/sessions — the public list of ongoing sessions (no codes, no auth). */
export const GET = route(async (req, { container }) => {
  rateLimit(`list:${clientIp(req)}`, 120, 60_000);
  return { items: await container.joinRequests.listPublic() };
});

/** POST /api/sessions — create a session; the caller becomes its host. */
export const POST = route(async (req, { container }) => {
  rateLimit(`create:${clientIp(req)}`, 20, 60_000);
  const body = await readJson(req);
  const { session, participant, token } = await container.sessions.create({
    name: body.name,
    hostName: body.hostName,
    settings: body.settings,
  });
  return { session: container.sessions.toSessionView(session), participantId: participant.id, token };
});
