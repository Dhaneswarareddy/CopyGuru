import { requireAuth, route } from '@/lib/http/handler';

/** GET /api/sessions/:id/questions?filter=&sort=&search=&limit=&offset= */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  const q = req.nextUrl.searchParams;
  return container.questions.list(session, participant, {
    filter: q.get('filter') ?? undefined,
    sort: q.get('sort') ?? undefined,
    search: q.get('search') ?? undefined,
    limit: Number(q.get('limit')) || undefined,
    offset: Number(q.get('offset')) || undefined,
  });
});
