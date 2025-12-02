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

  const sourceRecord = await prisma.source.findUnique({ where: { id: config.id } });
  const existingFailures = sourceRecord?.failureCount ?? 0;

  await prisma.sourceStatus.create({
    data: {
      sourceId: config.id,
      status: CrawlStatus.RUNNING,
      message: 'Crawl started',
      runAt: startedAt,
      attempts: existingFailures
    }
  });

  await prisma.source.update({
    where: { id: config.id },
    data: { lastRunAt: startedAt, lastStatus: CrawlStatus.RUNNING }
  });

  let context: Awaited<ReturnType<Browser['newContext']>> | null = null;
  try {
    const browser = await getBrowser(config.browser.headless);
    context = await browser.newContext({
      userAgent: config.browser.userAgent,
      viewport: config.browser.viewport
    });
    const page = await context.newPage();
    await page.goto(config.url, { timeout: config.browser.timeouts.navigationMs, waitUntil: 'networkidle' });

    const raw: Record<string, unknown> = {};
    for (const selector of config.selectorList) {
      const locator = selector.css ? page.locator(selector.css) : page.locator(`xpath=${selector.xpath}`);
      try {
        await locator.first().waitFor({ state: 'attached', timeout: config.browser.timeouts.actionMs });
        const element = locator.first();
        const value = selector.attribute ? await element.getAttribute(selector.attribute) : await element.textContent();
        raw[selector.field] = value?.toString().trim() ?? null;
      } catch (error) {
        console.error(`[crawl] selector failed for ${config.id} field ${selector.field}:`, error);
        raw[selector.field] = null;
      }
    }

    const parsed = applyParsers(raw, config.parse);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(config.outputSchema)) {
      output[key] = parsed[key] ?? raw[key] ?? null;
    }
    const validated = config.outputParser.parse(output);

    const scrapedAt = new Date();
    const timestampCandidate = validated.timestamp ?? parsed.timestamp ?? null;
    let normalizedTimestamp: Date | undefined;
    if (timestampCandidate) {
      const maybeDate =
        timestampCandidate instanceof Date ? timestampCandidate : new Date(String(timestampCandidate));
      normalizedTimestamp = Number.isNaN(maybeDate.getTime()) ? undefined : maybeDate;
    }

    const dataRow = await prisma.sourceData.create({
      data: {
        sourceId: config.id,
        raw,
        parsed: validated,
        scrapedAt,
        timestamp: normalizedTimestamp
      }
    });

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    console.info(`[crawl] finished ${config.id} in ${durationMs}ms`);

    await prisma.sourceStatus.create({
      data: {
        sourceId: config.id,
        status: CrawlStatus.SUCCESS,
        message: `Completed in ${durationMs}ms`,
        runAt: finishedAt,
        attempts: existingFailures
      }
    });

    await prisma.source.update({
      where: { id: config.id },
      data: { lastStatus: CrawlStatus.SUCCESS, lastRunAt: finishedAt, failureCount: 0 }
    });

    eventBus.emit(`source:${config.id}`, { type: 'data', sourceId: config.id, payload: dataRow });
    eventBus.emit('source_data:new', { sourceId: config.id, data: dataRow });
    eventBus.emit('crawl:finish', { sourceId: config.id, durationMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[crawl] error for ${config.id}: ${message}`);

    const updated = await prisma.source.update({
      where: { id: config.id },
      data: {
        lastStatus: CrawlStatus.ERROR,
        lastRunAt: new Date(),
        failureCount: { increment: 1 }
      }
    });

    await prisma.sourceStatus.create({
      data: {
        sourceId: config.id,
        status: CrawlStatus.ERROR,
        message,
        attempts: updated.failureCount
      }
    });

    eventBus.emit(`source:${config.id}`, { type: 'error', sourceId: config.id, error: message });
    eventBus.emit('crawl:error', { sourceId: config.id, error: message });
    throw error;
  } finally {
    if (context) {
      await context.close();
    }
  }
}

export async function shutdownCrawler() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
