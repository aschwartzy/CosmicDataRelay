import { PrismaClient, CrawlStatus } from '@prisma/client';
import { ResolvedSourceConfig } from '../config';
import { crawlSource } from '../crawler/crawler';
import { eventBus } from '../shared/eventBus';

interface SchedulerState {
  nextRun: number;
  attempts: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private state: Map<string, SchedulerState> = new Map();

  constructor(
    private prisma: PrismaClient,
    private sources: ResolvedSourceConfig[],
    private maxConcurrency = 2
  ) {
    this.sources.forEach((source) => {
      this.state.set(source.id, {
        nextRun: Date.now(),
        attempts: 0
      });
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private computeJitterMs(source: ResolvedSourceConfig) {
    const jitterSeconds = source.schedule.jitter;
    if (!jitterSeconds) return 0;
    const offset = (Math.random() * jitterSeconds * 2 - jitterSeconds) * 1000;
    return Math.floor(offset);
  }

  private async tick() {
    const now = Date.now();
    for (const source of this.sources) {
      if (this.inFlight >= this.maxConcurrency) {
        return;
      }

      const state = this.state.get(source.id)!;
      if (now < state.nextRun) {
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
    state.nextRun = Date.now() + source.schedule.minInterval * 1000 + jitter;
    try {
      await crawlSource(this.prisma, source);
      state.attempts = 0;
      state.nextRun = Date.now() + source.schedule.minInterval * 1000 + jitter;
      eventBus.emit('scheduler:success', { sourceId: source.id, durationMs: Date.now() - startedAt });
    } catch (error) {
      state.attempts += 1;
      const backoffSeconds = Math.min(
        source.schedule.minInterval * Math.pow(source.schedule.backoffMultiplier, state.attempts),
        source.schedule.maxBackoff
      );
      state.nextRun = Date.now() + backoffSeconds * 1000 + jitter;
      eventBus.emit('scheduler:error', { sourceId: source.id, error });
    } finally {
      await this.prisma.sourceStatus.create({
        data: {
          sourceId: source.id,
          status: CrawlStatus.IDLE,
          message: 'Scheduled',
          nextRunAt: new Date(state.nextRun),
          attempts: state.attempts
        }
      });
      this.inFlight -= 1;
    }
  }
}
