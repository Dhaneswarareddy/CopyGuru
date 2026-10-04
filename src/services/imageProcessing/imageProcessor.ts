import crypto from 'node:crypto';
import sharp from 'sharp';
import type { AppConfig } from '@/lib/config';
import { badRequest, payloadTooLarge, unsupportedMedia } from '@/lib/http/errors';

export interface ProcessedImage {
  /** Normalised image used for display and for embedding. */
  display: Buffer;
  thumb: Buffer;
  /** Only present when the storage policy keeps originals. */
  original: Buffer | null;
  originalFormat: string;
  width: number;
  height: number;
  sha256: string;
}

/**
 * Validates and normalises uploads. The file type is determined by actually
 * decoding the bytes (never by filename or the client-declared MIME type).
 * Output is re-encoded WebP with EXIF orientation applied and all metadata
 * (GPS, camera info) stripped.
 */
export class ImageProcessor {
  constructor(private cfg: AppConfig['images']) {}

  async process(input: Buffer): Promise<ProcessedImage> {
    if (!input?.length) throw badRequest('An image is required', 'IMAGE_REQUIRED');
    if (input.length > this.cfg.maxBytes)
      throw payloadTooLarge(`Image is too large (max ${Math.round(this.cfg.maxBytes / 1024 / 1024)} MB)`);

    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      meta = await sharp(input, { limitInputPixels: this.cfg.maxPixels, failOn: 'error' }).metadata();
    } catch {
      throw unsupportedMedia('That file is not a readable image');
    }
    const format = meta.format ?? 'unknown';
    if (!this.cfg.allowedFormats.includes(format))
      throw unsupportedMedia(`Unsupported image format "${format}". Use JPEG, PNG, WebP, GIF or AVIF.`);
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16)
      throw badRequest('Image is too small', 'IMAGE_TOO_SMALL');

    try {
      const base = () => sharp(input, { limitInputPixels: this.cfg.maxPixels, failOn: 'error' }).rotate();
      const { data: display, info } = await base()
        .resize({ width: this.cfg.displayMaxEdge, height: this.cfg.displayMaxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      const thumb = await base()
        .resize({ width: this.cfg.thumbMaxEdge, height: this.cfg.thumbMaxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      return {
        display,
        thumb,
        original: this.cfg.keepOriginal ? input : null,
        originalFormat: format,
        width: info.width,
        height: info.height,
        sha256: crypto.createHash('sha256').update(input).digest('hex'),
      };
    } catch {
      throw unsupportedMedia('That image could not be processed (it may be corrupt)');
    }
  }
}
