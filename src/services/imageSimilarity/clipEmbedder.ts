import { SimilarityUnavailableError, type ImageEmbedder } from './types';

interface ClipOptions {
  modelId: string;
  dtype: string;
  cacheDir: string;
  timeoutMs: number;
}

/**
 * Real semantic image embeddings from OpenAI CLIP (ViT-B/32 by default), run
 * locally with ONNX Runtime through transformers.js. No external API or key.
 * The vision tower + projection gives a 512-d vector in CLIP's joint space,
 * where different photos of the same subject land close together.
 */
export class ClipEmbedder implements ImageEmbedder {
  readonly dimensions = 512;
  readonly modelId: string;
  private loading: Promise<{ processor: any; model: any; RawImage: any }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private opts: ClipOptions) {
    this.modelId = `${opts.modelId}:${opts.dtype}`;
  }

  /** Loads (and on first run downloads) the model. Safe to call repeatedly. */
  warmup() {
    if (!this.loading) {
      this.loading = (async () => {
        const tf = await import('@huggingface/transformers');
        tf.env.cacheDir = this.opts.cacheDir;
        const processor = await tf.AutoProcessor.from_pretrained(this.opts.modelId);
        const model = await tf.CLIPVisionModelWithProjection.from_pretrained(this.opts.modelId, {
          dtype: this.opts.dtype as any,
        });
        return { processor, model, RawImage: tf.RawImage };
      })();
      // allow a later retry if loading failed (e.g. no network on first run)
      this.loading.catch(() => (this.loading = null));
    }
    return this.loading;
  }

  embed(image: Buffer): Promise<number[]> {
    // ONNX sessions are not re-entrant-friendly on small machines: run one at a time.
    const run = this.queue.then(() => this.withTimeout(this.embedNow(image)));
    this.queue = run.catch(() => {});
    return run;
  }

  private async embedNow(image: Buffer): Promise<number[]> {
    try {
      const { processor, model, RawImage } = await this.warmup();
      const raw = await RawImage.fromBlob(new Blob([new Uint8Array(image)]));
      const { image_embeds } = await model(await processor(raw));
      const v = Array.from(image_embeds.data as Float32Array);
      const norm = Math.hypot(...v);
      if (v.length !== this.dimensions || !Number.isFinite(norm) || norm === 0)
        throw new Error(`unexpected embedding (length ${v.length})`);
      return v.map((x) => x / norm);
    } catch (err) {
      throw new SimilarityUnavailableError('Could not generate an image embedding', err);
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SimilarityUnavailableError('Image embedding timed out')),
        this.opts.timeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
