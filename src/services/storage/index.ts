import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@/lib/config';
import type { Db } from '@/lib/database/client';

export interface StoredObject {
  data: Buffer;
  mime: string;
}

/** Object storage port. Add an S3 / R2 / GCS driver by implementing this. */
export interface StorageService {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

const MIME_BY_EXT: Record<string, string> = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };

/** Files on local disk / a mounted volume. Keys are server-generated. */
export class DiskStorage implements StorageService {
  private root: string;
  constructor(dir: string) {
    this.root = path.resolve(dir);
  }
  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }
  async get(key: string) {
    try {
      const data = await fs.readFile(this.resolve(key));
      return { data, mime: MIME_BY_EXT[path.extname(key)] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

/** Blobs in Postgres. Lets the app deploy as one stateless container + a database. */
export class DatabaseStorage implements StorageService {
  constructor(private db: Db) {}
  async put(key: string, data: Buffer, mime: string) {
    await this.db.query(
      `INSERT INTO stored_blobs (key, mime, data) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
      [key, mime, data],
    );
  }
  async get(key: string) {
    const row = await this.db.one<{ mime: string; data: Uint8Array }>(
      'SELECT mime, data FROM stored_blobs WHERE key = $1',
      [key],
    );
    return row ? { data: Buffer.from(row.data), mime: row.mime } : null;
  }
  async delete(key: string) {
    await this.db.query('DELETE FROM stored_blobs WHERE key = $1', [key]);
  }
}

export function createStorage(cfg: AppConfig['storage'], db: Db): StorageService {
  return cfg.driver === 'database' ? new DatabaseStorage(db) : new DiskStorage(cfg.dir);
}
