import type { SubmissionSource } from '@/lib/domain/types';
import { badRequest, payloadTooLarge } from '@/lib/http/errors';
import { requireAuth, route } from '@/lib/http/handler';
import { rateLimit } from '@/lib/http/rateLimit';

const SOURCES: SubmissionSource[] = ['upload', 'camera', 'sample', 'host'];

/** POST /api/sessions/:id/submissions — multipart: `image` (file) + `answer` (text). */
export const POST = route<{ id: string }>(async (req, { params, container }) => {
  const { session, participant } = await requireAuth(req, container, params.id);
  rateLimit(`submit:${participant.id}`, 30, 60_000);

  // reject oversized bodies before buffering them
  const max = container.config.images.maxBytes;
  if (Number(req.headers.get('content-length') ?? 0) > max + 64 * 1024)
    throw payloadTooLarge(`Image is too large (max ${Math.round(max / 1024 / 1024)} MB)`);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest('Expected multipart form data with "image" and "answer"');
  }
  const file = form.get('image');
  if (!(file instanceof Blob)) throw badRequest('An image is required', 'IMAGE_REQUIRED');
  if (file.size > max) throw payloadTooLarge(`Image is too large (max ${Math.round(max / 1024 / 1024)} MB)`);
  const source = String(form.get('source') ?? 'upload') as SubmissionSource;

  return container.submissions.submit(session, participant, {
    image: Buffer.from(await file.arrayBuffer()),
    answer: form.get('answer'),
    source: SOURCES.includes(source) ? source : 'upload',
  });
});
