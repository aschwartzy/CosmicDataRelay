import { getPrismaClient } from './db/client';
import { loadSourceConfigs, upsertSources } from './config';
import { Scheduler } from './scheduler/scheduler';
import { createApiServer } from './api/server';
import { registerWsServer } from './ws/wsServer';
import { shutdownCrawler } from './crawler/crawler';

async function bootstrap() {
  const prisma = getPrismaClient();
  const configs = await loadSourceConfigs();
  await upsertSources(prisma, configs);

  const api = createApiServer(prisma, configs);
  await registerWsServer(api);

  const scheduler = new Scheduler(prisma, configs, 2);
  scheduler.start();

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await api.listen({ port, host: '0.0.0.0' });
  api.log.info(`Server started on port ${port}`);

  const shutdown = async () => {
    api.log.info('Shutting down services...');
    scheduler.stop();
    await shutdownCrawler();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  console.error('Failed to start CosmicDataRelay', error);
  process.exit(1);
});
