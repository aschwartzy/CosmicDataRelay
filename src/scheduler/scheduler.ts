import { PrismaClient, CrawlStatus } from '@prisma/client';
import { ResolvedSourceConfig } from '../config';
import { crawlSource } from '../crawler/crawler';
import { eventBus } from '../shared/eventBus';
import { RETENTION_WINDOW_MS } from '../shared/constants';

interface SchedulerState {
  nextRun: number;
  failures: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private state: Map<string, SchedulerState> = new Map();

  constructor(
    private prisma: PrismaClient,
    private sources: ResolvedSourceConfig[],
    private maxConcurrency = 2
  ) {}

  async start() {
    if (this.timer) return;
    await this.hydrateState();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.cleanupTimer = setInterval(() => void this.cleanupHistory(), 60_000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async hydrateState() {
    for (const source of this.sources) {
      const record = await this.prisma.source.findUnique({
        where: { id: source.id },
        select: { failureCount: true }
      });
      this.state.set(source.id, {
        nextRun: Date.now(),
        failures: record?.failureCount ?? 0
      });
    }
  }

  private computeJitterMs(source: ResolvedSourceConfig) {
    const jitterMs = source.schedule.jitterMs;
    if (!jitterMs) return 0;
    const offset = Math.random() * jitterMs * 2 - jitterMs;
    return Math.floor(offset);
  }

  private async tick() {
    const now = Date.now();
    const sortedSources = [...this.sources].sort((a, b) => {
      const aState = this.state.get(a.id)?.nextRun ?? 0;
      const bState = this.state.get(b.id)?.nextRun ?? 0;
      return aState - bState;
    });

    for (const source of sortedSources) {
      if (!source.enabled) {
        continue;
      }
      if (this.inFlight >= this.maxConcurrency) {
        return;
      }

      const state = this.state.get(source.id);
      if (!state || now < state.nextRun) {
        continue;
      }

      this.runSource(source, state).catch((error) => {
        console.error(`[scheduler] error running ${source.id}:`, error);
      });
    }
  }

  private async runSource(source: ResolvedSourceConfig, state: SchedulerState) {
    this.inFlight += 1;
    const startedAt = Date.now();
    const jitter = this.computeJitterMs(source);
    state.nextRun = Date.now() + source.schedule.effectiveIntervalMs + jitter;
    try {
      await crawlSource(this.prisma, source);
      state.failures = 0;
      state.nextRun = Date.now() + source.schedule.effectiveIntervalMs + jitter;
      eventBus.emit('scheduler:success', { sourceId: source.id, durationMs: Date.now() - startedAt });
    } catch (error) {
      state.failures += 1;
      const backoffMs = Math.min(
        source.schedule.effectiveIntervalMs * Math.pow(source.schedule.backoffMultiplier, state.failures),
        source.schedule.maxBackoffMs
      );
      state.nextRun = Date.now() + backoffMs + jitter;
      if (state.failures >= source.schedule.failureLimit) {
        const pauseMs = 24 * 60 * 60 * 1000;
        state.nextRun = Date.now() + pauseMs;
        console.warn(
          `[scheduler] ${source.id} exceeded failure limit (${source.schedule.failureLimit}); pausing for 24h`
        );
      }
      eventBus.emit('scheduler:error', { sourceId: source.id, error });
    } finally {
      await this.prisma.sourceStatus.create({
        data: {
          sourceId: source.id,
          status: CrawlStatus.IDLE,
          message: 'Scheduled',
          nextRunAt: new Date(state.nextRun),
          attempts: state.failures
        }
      });
      this.inFlight -= 1;
    }
  }

  private async cleanupHistory() {
    try {
      const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
      const result = await this.prisma.sourceData.deleteMany({
        where: { scrapedAt: { lt: cutoff } }
      });
      if (result.count > 0) {
        console.info(`[scheduler] cleaned up ${result.count} stale rows older than 4h`);
      }
    } catch (error) {
      console.error('[scheduler] failed to cleanup history', error);
    }
  }
}
