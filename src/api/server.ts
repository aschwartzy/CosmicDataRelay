import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ResolvedSourceConfig } from '../config';

export function createApiServer(prisma: PrismaClient, configs: ResolvedSourceConfig[]) {
  const fastify = Fastify({ logger: true });

  fastify.addHook('onRequest', (request, _reply, done) => {
    request.log.info({ method: request.method, url: request.url }, 'incoming request');
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    request.log.info({ statusCode: reply.statusCode }, 'completed request');
    done();
  });

  fastify.get('/api/sources', async () => {
    const sources = await prisma.source.findMany({
      include: {
        statuses: { orderBy: { runAt: 'desc' }, take: 1 }
      }
    });
    return { sources };
  });

  fastify.get<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    const source = await prisma.source.findUnique({
      where: { id: request.params.id },
      include: { statuses: { orderBy: { runAt: 'desc' }, take: 5 } }
    });

    if (!source) {
      reply.code(404);
      return { message: 'Source not found' };
    }

    return source;
  });

  fastify.get<{ Params: { id: string } }>('/api/sources/:id/latest', async (request, reply) => {
    const sourceId = request.params.id;
    const latest = await prisma.sourceData.findFirst({
      where: { sourceId },
      orderBy: { collectedAt: 'desc' }
    });

    if (!latest) {
      reply.code(404);
      return { message: 'No data found for source' };
    }

    return latest;
  });

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/sources/:id/history',
    async (request, reply) => {
      const sourceId = request.params.id;
      const limit = request.query.limit ? Number(request.query.limit) : 20;
      const history = await prisma.sourceData.findMany({
        where: { sourceId },
        orderBy: { collectedAt: 'desc' },
        take: limit
      });

      if (!history.length) {
        reply.code(404);
        return { message: 'No history found for source' };
      }

      return history;
    }
  );

  fastify.get('/api/config/sources', async () => configs);

  return fastify;
}
