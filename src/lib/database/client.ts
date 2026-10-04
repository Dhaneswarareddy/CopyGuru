import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Thin database abstraction over two Postgres drivers:
 *   - `pg`      → any real PostgreSQL with pgvector (production: DATABASE_URL)
 *   - `PGlite`  → embedded PostgreSQL + pgvector (zero-install local dev & tests)
 * Both speak the same SQL, so repositories are driver-agnostic.
 *
 * Transactions are propagated with AsyncLocalStorage: code running inside
 * `db.tx(...)` transparently uses the transaction connection.
 */
export interface Db {
  readonly driver: 'postgres' | 'pglite';
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Runs multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Queryable = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
function mapRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k in row) out[camel(k)] = row[k];
  return out;
}

abstract class BaseDb implements Db {
  abstract readonly driver: 'postgres' | 'pglite';
  protected als = new AsyncLocalStorage<Queryable>();
  protected abstract root(): Queryable;
  abstract exec(sql: string): Promise<void>;
  abstract tx<T>(fn: () => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const target = this.als.getStore() ?? this.root();
    const res = await target.query(sql, params as any[]);
    return res.rows.map(mapRow) as T[];
  }
  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }
}

class PgDb extends BaseDb {
  readonly driver = 'postgres' as const;
  constructor(private pool: import('pg').Pool) {
    super();
  }
  protected root() {
    return this.pool;
  }
  async exec(sql: string) {
    await (this.als.getStore() ?? this.pool).query(sql);
  }
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn(); // already inside a transaction
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.als.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

class PgliteDb extends BaseDb {
  readonly driver = 'pglite' as const;
  constructor(private pg: import('@electric-sql/pglite').PGlite) {
    super();
  }
  protected root() {
    return this.pg as unknown as Queryable;
  }
  async exec(sql: string) {
    const store = this.als.getStore() as any;
    await (store ?? this.pg).exec(sql);
  }
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();
    return this.pg.transaction((tx) => this.als.run(tx as unknown as Queryable, fn)) as Promise<T>;
  }
  async close() {
    await this.pg.close();
  }
}

export async function createDb(opts: { url: string | null; pgliteDir: string }): Promise<Db> {
  if (opts.url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: opts.url, max: 10 });
    return new PgDb(pool);
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const dir = opts.pgliteDir;
  if (!dir.startsWith('memory://')) fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
  const pglite = new PGlite(dir, { extensions: { vector } });
  await pglite.waitReady;
  return new PgliteDb(pglite);
}

export const toVectorLiteral = (embedding: number[]) => `[${embedding.join(',')}]`;
