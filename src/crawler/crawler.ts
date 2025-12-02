import { chromium, Browser } from 'playwright';
import { PrismaClient, CrawlStatus } from '@prisma/client';
import { ResolvedSourceConfig, applyParsers } from '../config';
import { eventBus } from '../shared/eventBus';

let browserInstance: Browser | null = null;

async function getBrowser(headless: boolean) {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless });
  }
  return browserInstance;
}

export async function crawlSource(prisma: PrismaClient, config: ResolvedSourceConfig) {
  const startedAt = new Date();
  console.info(`[crawl] starting ${config.id} at ${startedAt.toISOString()}`);
  eventBus.emit('crawl:start', { sourceId: config.id, at: startedAt });

  await prisma.sourceStatus.create({
    data: {
      sourceId: config.id,
      status: CrawlStatus.RUNNING,
      message: 'Crawl started'
    }
  });

  try {
    const browser = await getBrowser(config.browser.headless);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(config.url, { timeout: config.browser.timeout, waitUntil: 'networkidle' });

    const raw: Record<string, unknown> = {};
    for (const selector of config.selectors) {
      const element = await page.waitForSelector(selector.selector, { timeout: config.browser.timeout });
      if (!element) {
        raw[selector.field] = null;
        continue;
      }
      const value = selector.attribute
        ? await element.getAttribute(selector.attribute)
        : await element.textContent();
      raw[selector.field] = value?.toString().trim() ?? null;
    }

    const parsed = applyParsers(raw, config.parse);
    const validated = config.outputParser.parse(parsed);

    await prisma.sourceData.create({
      data: {
        sourceId: config.id,
        raw,
        parsed: validated
      }
    });

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    console.info(`[crawl] finished ${config.id} in ${durationMs}ms`);

    await prisma.sourceStatus.create({
      data: {
        sourceId: config.id,
        status: CrawlStatus.SUCCESS,
        message: `Completed in ${durationMs}ms`
      }
    });

    eventBus.emit(`source:${config.id}`, { type: 'data', sourceId: config.id, payload: validated });
    eventBus.emit('crawl:finish', { sourceId: config.id, durationMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[crawl] error for ${config.id}: ${message}`);
    await prisma.sourceStatus.create({
      data: {
        sourceId: config.id,
        status: CrawlStatus.ERROR,
        message
      }
    });
    eventBus.emit(`source:${config.id}`, { type: 'error', sourceId: config.id, error: message });
    eventBus.emit('crawl:error', { sourceId: config.id, error: message });
    throw error;
  }
}

export async function shutdownCrawler() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
