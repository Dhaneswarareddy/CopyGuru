import { verifyImageSignature } from '@/lib/auth/tokens';
import { notFound } from '@/lib/http/errors';
import { route } from '@/lib/http/handler';

/**
 * GET /api/images/:id?v=thumb|display&sig=… — signed image delivery. The
 * signature is minted only inside API responses to authorised participants.
 */
export const GET = route<{ id: string }>(async (req, { params, container }) => {
  const sig = req.nextUrl.searchParams.get('sig');
  if (!/^[0-9a-f-]{36}$/i.test(params.id) || !verifyImageSignature(container.config.appSecret, params.id, sig))
    throw notFound('Image');
  const image = await container.repos.questions.findImage(params.id);
  if (!image) throw notFound('Image');
  const variant = req.nextUrl.searchParams.get('v') === 'display' ? image.displayKey : image.thumbKey;
  const object = await container.storage.get(variant);
  if (!object) throw notFound('Image');
  return new Response(new Uint8Array(object.data), {
    headers: {
      'Content-Type': object.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
