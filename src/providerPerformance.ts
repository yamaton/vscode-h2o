import { performance } from 'node:perf_hooks';

export type ProviderPerformanceKind = 'completion' | 'hover';

export interface ProviderPhaseTimings {
  totalMs: number;
  /** End-to-end wait for a document tree. This includes parseMs when parsing occurs. */
  treeWaitMs: number;
  /** Time spent synchronously inside Parser.parse. This is a subset of treeWaitMs. */
  parseMs: number;
  treeCopyMs: number;
  analysisMs: number;
  commandFetchMs: number;
  pathResolveMs: number;
  /** Total time not attributed to the non-overlapping phases above. */
  unclassifiedMs: number;
}

export type ProviderAccumulatedPhase = Exclude<
  keyof ProviderPhaseTimings,
  'totalMs' | 'unclassifiedMs'
>;

export interface ProviderPerformanceSample {
  sequence: number;
  kind: ProviderPerformanceKind;
  outcome: string;
  timings: ProviderPhaseTimings;
}

export class ProviderMeasurement {
  private readonly startedAt: number;
  private readonly phases: Record<ProviderAccumulatedPhase, number> = {
    treeWaitMs: 0,
    parseMs: 0,
    treeCopyMs: 0,
    analysisMs: 0,
    commandFetchMs: 0,
    pathResolveMs: 0,
  };
  private finished: ProviderPhaseTimings | undefined;

  public constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  public add(phase: ProviderAccumulatedPhase, durationMs: number): void {
    if (this.finished || !Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    this.phases[phase] += durationMs;
  }

  public measure<T>(phase: ProviderAccumulatedPhase, operation: () => T): T {
    const startedAt = this.now();
    try {
      return operation();
    } finally {
      this.add(phase, this.now() - startedAt);
    }
  }

  public async measureAsync<T>(phase: ProviderAccumulatedPhase, operation: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      this.add(phase, this.now() - startedAt);
    }
  }

  public finish(): ProviderPhaseTimings {
    if (!this.finished) {
      const totalMs = Math.max(0, this.now() - this.startedAt);
      const classifiedMs = this.phases.treeWaitMs
        + this.phases.treeCopyMs
        + this.phases.analysisMs
        + this.phases.commandFetchMs
        + this.phases.pathResolveMs;
      this.finished = Object.freeze({
        totalMs,
        ...this.phases,
        unclassifiedMs: Math.max(0, totalMs - classifiedMs),
      });
    }
    return this.finished;
  }
}

export class ProviderPerformanceRecorder {
  private readonly samples: ProviderPerformanceSample[] = [];
  private sequence = 0;

  public constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('Provider performance recorder capacity must be a positive integer.');
    }
  }

  public record(
    kind: ProviderPerformanceKind,
    outcome: string,
    timings: ProviderPhaseTimings,
  ): ProviderPerformanceSample {
    const sample = Object.freeze({
      sequence: ++this.sequence,
      kind,
      outcome,
      timings,
    });
    this.samples.push(sample);
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity);
    }
    return sample;
  }

  public snapshot(): ProviderPerformanceSample[] {
    return [...this.samples];
  }

  public clear(): void {
    this.samples.length = 0;
  }
}
