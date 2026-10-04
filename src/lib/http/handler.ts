import { NextResponse, type NextRequest } from 'next/server';
import { getContainer, type Container } from '@/lib/container';
import type { ParticipantRow, SessionRow } from '@/lib/domain/types';
import { badRequest, forbidden, unauthorized, type AppError } from './errors';

export interface RouteContext<P> {
  params: P;
  container: Container;
}

/**
 * Wraps a route handler: resolves the container, awaits params, serialises
 * the result and maps errors to a consistent JSON shape
 * `{ error: { code, message } }`. Route files stay one-liners that delegate
 * to services.
 */
export function route<P = Record<string, string>>(
  fn: (req: NextRequest, ctx: RouteContext<P>) => Promise<unknown>,
) {
  return async (req: NextRequest, raw: { params: Promise<P> }) => {
    try {
      const container = await getContainer();
      const out = await fn(req, { params: await raw.params, container });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown) {
  // Duck-typed on purpose: services run in the custom server's module graph,
  // route handlers in Next's bundle, so `instanceof AppError` can be false for
  // a genuine AppError.
  const e = err as Partial<AppError> | null;
  if (e && e.name === 'AppError' && typeof e.status === 'number' && typeof e.code === 'string')
    return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status });
  // unique-constraint races surface as conflicts rather than 500s
  if ((err as { code?: string })?.code === '23505')
    return NextResponse.json({ error: { code: 'CONFLICT', message: 'That has already been done' } }, { status: 409 });
  console.error('[api] unhandled error:', err);
  return NextResponse.json({ error: { code: 'INTERNAL', message: 'Something went wrong' } }, { status: 500 });
}

/**
 * Authenticates the bearer token. When `sessionRef` (code or id from the URL)
 * is given, the token must belong to exactly that session.
 */
export async function requireAuth(
  req: Request,
  container: Container,
  sessionRef?: string,
): Promise<{ session: SessionRow; participant: ParticipantRow }> {
  const token = bearerToken(req);
  if (!token) throw unauthorized();
  const auth = await container.sessions.authenticate(token);
  if (sessionRef !== undefined) {
    const ref = sessionRef.trim();
    if (ref.toLowerCase() !== auth.session.id && ref.toUpperCase() !== auth.session.code)
      throw forbidden('You are not a member of this session', 'NOT_A_MEMBER');
  }
  return auth;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be a JSON object');
  }
}
