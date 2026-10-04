import { readJson, requireAuth, route } from '@/lib/http/handler';
import { clientIp, rateLimit } from '@/lib/http/rateLimit';

/** POST { displayName } — ask to join a session from the public list (`:id` is its public id). */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  rateLimit(`join-request:${clientIp(req)}`, 8, 60_000);
  const body = await readJson(req);
  return container.joinRequests.request(params.id, { displayName: body.displayName });
});

/** GET — people currently waiting to be let in (hosts only). */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  return { items: await container.joinRequests.listPending(session, participant) };
});
