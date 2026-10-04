/**
 * Central runtime configuration. Everything tunable lives here and is driven by
 * environment variables, so thresholds / models / storage can change without
 * touching business logic.
 */

const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/** Dimension of the pgvector column. Changing the embedding model to one with a
 *  different output size requires a migration of `question_images.embedding`. */
export const EMBEDDING_DIMENSIONS = 512;

export interface AppConfig {
  env: string;
  appSecret: string;
  demoMode: boolean;
  database: { url: string | null; pgliteDir: string };
  storage: { driver: 'disk' | 'database'; dir: string };
  images: {
    maxBytes: number;
    maxPixels: number;
    displayMaxEdge: number;
    thumbMaxEdge: number;
    keepOriginal: boolean;
    allowedFormats: string[];
  };
  similarity: {
    provider: string;
    modelId: string;
    dtype: string;
    cacheDir: string;
    highThreshold: number;
    possibleThreshold: number;
    topK: number;
    timeoutMs: number;
  };
  consensus: {
    /** Percent thresholds (top answer share). */
    high: number;
    moderate: number;
    low: number;
    /** Minimum answers before a "reached consensus" notification is sent. */
    notifyMinAnswers: number;
  };
  limits: { maxAnswerLength: number; maxNameLength: number; maxParticipants: number; pageSize: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    env: env.NODE_ENV ?? 'development',
    appSecret: env.APP_SECRET ?? 'dev-insecure-secret-change-me',
    demoMode: bool(env.DEMO_MODE, true),
    database: {
      url: env.DATABASE_URL || null,
      pgliteDir: env.PGLITE_DIR ?? './.data/pglite',
    },
    storage: {
      driver: env.STORAGE_DRIVER === 'database' ? 'database' : 'disk',
      dir: env.STORAGE_DIR ?? './.data/uploads',
    },
    images: {
      maxBytes: num(env.IMAGE_MAX_BYTES, 10 * 1024 * 1024),
      maxPixels: num(env.IMAGE_MAX_PIXELS, 50_000_000),
      displayMaxEdge: num(env.IMAGE_DISPLAY_MAX_EDGE, 1280),
      thumbMaxEdge: num(env.IMAGE_THUMB_MAX_EDGE, 360),
      keepOriginal: bool(env.IMAGE_KEEP_ORIGINAL, false),
      allowedFormats: (env.IMAGE_ALLOWED_FORMATS ?? 'jpeg,png,webp,gif,avif').split(',').map((s) => s.trim()),
    },
    similarity: {
      provider: env.SIMILARITY_PROVIDER ?? 'clip',
      modelId: env.SIMILARITY_MODEL ?? 'Xenova/clip-vit-base-patch32',
      dtype: env.SIMILARITY_DTYPE ?? 'q8',
      cacheDir: env.MODEL_CACHE_DIR ?? './.cache/models',
      // Calibrated on real photos with CLIP ViT-B/32 (see scripts/calibrate.ts).
      highThreshold: num(env.SIMILARITY_HIGH_THRESHOLD, 0.86),
      possibleThreshold: num(env.SIMILARITY_POSSIBLE_THRESHOLD, 0.66),
      topK: num(env.SIMILARITY_TOP_K, 10),
      timeoutMs: num(env.SIMILARITY_TIMEOUT_MS, 60_000),
    },
    consensus: {
      high: num(env.CONSENSUS_HIGH, 75),
      moderate: num(env.CONSENSUS_MODERATE, 50),
      low: num(env.CONSENSUS_LOW, 25),
      notifyMinAnswers: num(env.CONSENSUS_NOTIFY_MIN_ANSWERS, 3),
    },
    limits: {
      maxAnswerLength: 500,
      maxNameLength: 40,
      maxParticipants: num(env.MAX_PARTICIPANTS, 200),
      pageSize: 30,
    },
  };
}
