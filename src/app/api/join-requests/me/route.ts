import { bearerToken, route } from '@/lib/http/handler';

/** GET — the waiting visitor checks on their own request (Bearer: the token from the request). */
export const GET = route(async (req, { container }) => container.joinRequests.status(bearerToken(req)));

/** DELETE — the waiting visitor gives up. */
export const DELETE = route(async (req, { container }) => container.joinRequests.cancel(bearerToken(req)));
