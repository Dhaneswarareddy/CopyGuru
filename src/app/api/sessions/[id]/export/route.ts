import { requireAuth, route } from '@/lib/http/handler';

/** GET — every answer in the session as a CSV file (hosts only). */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  const csv = await container.sessions.exportCsv(session, participant);
  return new Response('﻿' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="session-${session.code}-results.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
