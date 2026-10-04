import { readJson, requireAuth, route } from '@/lib/http/handler';

/** POST { decision: APPROVE | DECLINE } — a host admits or declines; returns who is still waiting. */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container);
  const body = await readJson(req);
  return { items: await container.joinRequests.decide(session, participant, params.id, body.decision) };
});
