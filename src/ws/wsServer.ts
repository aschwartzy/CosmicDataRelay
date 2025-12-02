import websocketPlugin from '@fastify/websocket';
import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ResolvedSourceConfig } from '../config';
import { eventBus } from '../shared/eventBus';
import { RETENTION_WINDOW_MS } from '../shared/constants';

export async function registerWsServer(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  configs: ResolvedSourceConfig[]
) {
  await fastify.register(websocketPlugin);

  fastify.get('/ws/sources/:id', { websocket: true }, async (connection, request) => {
    const { id } = request.params as { id: string };
    const sourceConfig = configs.find((entry) => entry.id === id);
    const source = await prisma.source.findUnique({ where: { id } });

    if (!sourceConfig || !source || !source.enabled) {
      connection.socket.send(JSON.stringify({ type: 'error', message: 'Unknown or disabled source' }));
      connection.socket.close(1008, 'Unknown source');
      return;
    }

    const channel = `source:${id}`;

    const sendMessage = (payload: unknown) => {
      connection.socket.send(JSON.stringify(payload));
    };

    const handler = (payload: { sourceId: string; data?: unknown; error?: string; type?: string }) => {
      if (payload.sourceId === id) {
        sendMessage({ type: 'update', sourceId: id, payload });
      }
    };

    eventBus.on('source_data:new', handler);
    eventBus.on(channel, handler);

    connection.socket.on('close', () => {
      eventBus.off('source_data:new', handler);
      eventBus.off(channel, handler);
    });

    sendMessage({ type: 'connected', sourceId: id });

    const latest = await prisma.sourceData.findFirst({
      where: { sourceId: id, scrapedAt: { gte: new Date(Date.now() - RETENTION_WINDOW_MS) } },
      orderBy: { scrapedAt: 'desc' }
    });

    if (latest) {
      sendMessage({ type: 'latest', sourceId: id, payload: latest });
    }
  });
}
