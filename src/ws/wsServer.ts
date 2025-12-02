import websocketPlugin from '@fastify/websocket';
import { FastifyInstance } from 'fastify';
import { eventBus } from '../shared/eventBus';

export async function registerWsServer(fastify: FastifyInstance) {
  await fastify.register(websocketPlugin);

  fastify.get('/ws/sources/:id', { websocket: true }, (connection, request) => {
    const { id } = request.params as { id: string };
    const channel = `source:${id}`;

    const sendMessage = (payload: unknown) => {
      connection.socket.send(JSON.stringify(payload));
    };

    const handler = (payload: unknown) => sendMessage(payload);
    eventBus.on(channel, handler);

    connection.socket.on('close', () => {
      eventBus.off(channel, handler);
    });

    sendMessage({ type: 'connected', sourceId: id });
  });
}
