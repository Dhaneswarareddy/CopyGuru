import { route } from '@/lib/http/handler';
import { clientIp, rateLimit } from '@/lib/http/rateLimit';

/** POST /api/sessions/demo — seeded demo session with one token per identity. */
export const POST = route(async (req, { container }) => {
  rateLimit(`demo:${clientIp(req)}`, 6, 60_000);
  return container.demo.create();
});
