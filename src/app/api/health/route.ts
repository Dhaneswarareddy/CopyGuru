import { route } from '@/lib/http/handler';

export const dynamic = 'force-dynamic';

export const GET = route(async (_req, { container }) => {
  await container.db.query('SELECT 1');
  return { ok: true, database: container.db.driver, similarityModel: container.similarity.modelId };
});
