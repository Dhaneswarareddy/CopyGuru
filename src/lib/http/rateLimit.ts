import { tooManyRequests } from './errors';

/**
 * Small in-memory fixed-window limiter. Enough to blunt abuse on a single
 * instance; put a shared store (Redis) behind this when scaling out.
 */
const g = globalThis as unknown as { __vqaRate?: Map<string, { count: number; resetAt: number }> };
const buckets = (g.__vqaRate ??= new Map());

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    return;
  }
  if (++bucket.count > limit) throw tooManyRequests();
}

export function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
}
