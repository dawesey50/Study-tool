import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, repoRoot } from './config.js';
import { closeDb, initDb, isVecAvailable } from './db/index.js';
import { embedderStatus } from './embeddings/index.js';
import { moduleRoutes } from './routes/modules.js';
import { noteRoutes } from './routes/notes.js';
import { searchRoutes } from './routes/search.js';
import { sourceRoutes } from './routes/sources.js';

export async function buildServer() {
  initDb();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  // Several endpoints take no body at all. Fastify's default JSON parser
  // rejects an empty body outright when the content-type says JSON, which
  // turns a harmless POST into a confusing 400, so treat empty as {}.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string | Buffer, done) => {
      const text = body.toString().trim();
      if (!text) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // Single user on localhost, so CORS only needs to admit the Vite dev server.
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  });

  // Extracted figures are served straight off disk.
  await app.register(fastifyStatic, {
    root: config.mediaDir,
    prefix: '/media/',
    decorateReply: false,
  });

  await app.register(moduleRoutes);
  await app.register(sourceRoutes);
  await app.register(noteRoutes);
  await app.register(searchRoutes);

  // In production the built frontend is served by the same process, so the
  // whole app is one command and one port.
  const webDist = path.join(repoRoot, 'web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      decorateReply: false,
    });
    // Client-side routing: anything not matched above falls back to the SPA.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/media/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    });
  }

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', details: error.issues });
    }
    request.log.error(error);
    const { statusCode, message } = error as { statusCode?: number; message?: string };
    return reply.code(statusCode ?? 500).send({ error: message || 'Internal server error' });
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  const shutdown = async () => {
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });

  const status = embedderStatus();
  app.log.info(
    `Processor ready — data in ${config.dataDir}, ` +
      `embeddings: ${status.provider} (${status.state}), ` +
      `vectors: ${isVecAvailable() ? 'sqlite-vec' : 'brute force'}`,
  );
}

// Only start a server when run directly; tests import buildServer instead.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
