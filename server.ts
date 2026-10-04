/**
 * Custom server: Next.js (pages + REST API) and Socket.IO on one HTTP port.
 * One process, one port — deployable as a single container.
 */
import { createServer } from 'node:http';
import next from 'next';
import { getContainer } from './src/lib/container';
import { attachRealtime } from './src/lib/realtime/socketServer';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME_BIND ?? '0.0.0.0';

async function main() {
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[server] request failed:', err);
      res.statusCode = 500;
      res.end('Internal error');
    });
  });
  attachRealtime(httpServer);

  // migrate the database before accepting traffic
  const container = await getContainer();
  console.log(`[server] database: ${container.db.driver}, storage: ${container.config.storage.driver}`);

  httpServer.listen(port, hostname, () => {
    console.log(`[server] ready on http://localhost:${port} (${dev ? 'development' : 'production'})`);
  });

  // load the embedding model in the background so the first upload is fast
  const embedder = container.embedder as { warmup?: () => Promise<unknown> };
  embedder.warmup?.().then(
    () => console.log(`[server] similarity model ready: ${container.similarity.modelId}`),
    (err: unknown) => console.error('[server] similarity model failed to load (uploads will offer a retry):', err),
  );

  const shutdown = () => {
    httpServer.close(() => container.db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
