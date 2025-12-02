import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ResolvedSourceConfig } from '../config';
import { RETENTION_WINDOW_MS } from '../shared/constants';

export function createApiServer(prisma: PrismaClient, configs: ResolvedSourceConfig[]) {
  const fastify = Fastify({ logger: true });

  const serializeConfig = (config: ResolvedSourceConfig) => {
    const { outputParser: _parser, ...rest } = config;
    return rest;
  };

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
      select: {
        id: true,
        name: true,
        description: true,
        url: true,
        enabled: true,
        lastRunAt: true,
        lastStatus: true,
        failureCount: true
      }
    });
    return { sources };
  });

  fastify.get<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    const config = configs.find((entry) => entry.id === request.params.id);
    const source = await prisma.source.findUnique({
      where: { id: request.params.id },
      include: { statuses: { orderBy: { runAt: 'desc' }, take: 5 } }
    });

    if (!source || !config) {
      reply.code(404);
      return { message: 'Source not found' };
    }

    return { ...source, config: serializeConfig(config) };
  });

  fastify.get<{ Params: { id: string } }>('/api/sources/:id/latest', async (request, reply) => {
    const sourceId = request.params.id;
    const source = await prisma.source.findUnique({ where: { id: sourceId } });
    if (!source || !source.enabled) {
      reply.code(404);
      return { message: 'Source not found or disabled' };
    }

    const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
    const latest = await prisma.sourceData.findFirst({
      where: { sourceId, scrapedAt: { gte: cutoff } },
      orderBy: { scrapedAt: 'desc' }
    });

    if (!latest) {
      reply.code(404);
      return { message: 'No data found for source' };
    }

    return latest;
  });

  fastify.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/api/sources/:id/history',
    async (request, reply) => {
      const sourceId = request.params.id;
      const source = await prisma.source.findUnique({ where: { id: sourceId } });
      if (!source || !source.enabled) {
        reply.code(404);
        return { message: 'Source not found or disabled' };
      }

      const now = Date.now();
      const defaultFrom = new Date(now - RETENTION_WINDOW_MS);
      const queryFrom = request.query.from ? new Date(request.query.from) : defaultFrom;
      const queryTo = request.query.to ? new Date(request.query.to) : new Date(now);

      if (Number.isNaN(queryFrom.getTime()) || Number.isNaN(queryTo.getTime())) {
        reply.code(400);
        return { message: 'Invalid date range' };
      }

      const lowerBound = queryFrom < defaultFrom ? defaultFrom : queryFrom;
      const upperBound = queryTo > new Date(now) ? new Date(now) : queryTo;

      if (lowerBound > upperBound) {
        reply.code(400);
        return { message: 'from must be before to' };
      }

      const history = await prisma.sourceData.findMany({
        where: { sourceId, scrapedAt: { gte: lowerBound, lte: upperBound } },
        orderBy: { scrapedAt: 'asc' }
      });

      if (!history.length) {
        reply.code(404);
        return { message: 'No history found for source' };
      }

      return { from: lowerBound, to: upperBound, data: history };
    }
  );

  fastify.get('/api/config/sources', async () => configs.map((config) => serializeConfig(config)));

  return fastify;
}
