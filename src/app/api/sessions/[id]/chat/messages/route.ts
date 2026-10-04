import { readJson, requireAuth, route } from '@/lib/http/handler';
import { rateLimit } from '@/lib/http/rateLimit';

/** GET ?with=public|<participantId>&before=<messageId>&limit= — one conversation, oldest first. */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  const q = req.nextUrl.searchParams;
  return container.chat.messages(session, participant, {
    channel: q.get('with') ?? 'public',
    before: q.get('before'),
    limit: Number(q.get('limit')) || undefined,
  });
});

/** POST { to: "public" | participantId, text } */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  rateLimit(`chat:${participant.id}`, 30, 10_000);
  const body = await readJson(req);
  return container.chat.send(session, participant, { to: body.to, text: body.text });
});
