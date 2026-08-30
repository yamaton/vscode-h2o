export type PerformanceGateMode = 'enforce' | 'shadow';
export type ComparedStatistic = 'maximum' | 'p50' | 'p95';
export type TopLevelMetric = 'externalTotalMs' | 'maxEventLoopDelayMs' | 'provider';

interface Distribution {
  minimum: number;
  p50: number;
  p95: number;
  maximum: number;
  mean: number;
}

export interface ValueComparison {
  armA: Distribution;
  armB: Distribution;
  comparisonStatistic: 'maximum' | 'p50';
  armAValueMs: number;
  armBValueMs: number;
  differenceMs: number;
  relativePercent: number | null;
}

export type MetricComparison = Record<ComparedStatistic, ValueComparison>;

export interface ScenarioComparison {
  name: string;
  externalTotalMs: MetricComparison;
  maxEventLoopDelayMs: MetricComparison;
  provider: Record<string, MetricComparison> | null;
}

export interface PerformanceComparisonReport {
  schemaVersion: number;
  comparison: string;
  generatedAt: string;
  source: {
    sameSource: boolean;
    armA: { sha: string | null; digestSha256: string };
    armB: { sha: string | null; digestSha256: string };
  };
  vscode: { requested: string; actual: string };
  comparisons: ScenarioComparison[];
}

export interface PerformanceThresholdRule {
  id: string;
  scenarioPattern: RegExp;
  metric: TopLevelMetric;
  providerPhase?: string;
  statistic: ComparedStatistic;
  absoluteMs: number;
  relativePercent: number;
  blocking: boolean;
}

export interface PerformanceFinding {
  ruleId: string;
  scenario: string;
  metric: string;
  statistic: ComparedStatistic;
  baselineMs: number;
  targetMs: number;
  differenceMs: number;
  relativePercent: number | null;
  absoluteThresholdMs: number;
  relativeThresholdPercent: number;
  blocking: boolean;
  exceeded: boolean;
}

export interface PerformanceEvaluation {
  schemaVersion: 1;
  mode: PerformanceGateMode;
  sameSource: boolean;
  passed: boolean;
  blockingRegressionCount: number;
  observedRegressionCount: number;
  findings: PerformanceFinding[];
}

const cacheHitPattern = /^(completion|hover)-cache-hit$/;
const editPattern = /^completion-after-edit-/;
export const requiredPerformanceScenarioNames = [
  'cold-activation-empty',
  'completion-cache-hit',
  'hover-cache-hit',
  'completion-cache-miss',
  'completion-after-edit-10240',
  'completion-after-edit-102400',
  'completion-after-edit-1048576',
  'cold-activation-general',
  'cold-activation-general-bio',
] as const;

export const defaultPerformanceThresholds: readonly PerformanceThresholdRule[] = [
  {
    id: 'activation-p50',
    scenarioPattern: /^cold-activation-/,
    metric: 'externalTotalMs',
    statistic: 'p50',
    absoluteMs: 25,
    relativePercent: 20,
    blocking: true,
  },
  {
    id: 'activation-event-loop-maximum',
    scenarioPattern: /^cold-activation-/,
    metric: 'maxEventLoopDelayMs',
    statistic: 'maximum',
    absoluteMs: 10,
    relativePercent: 25,
    blocking: false,
  },
  {
    id: 'cache-hit-provider-p50',
    scenarioPattern: cacheHitPattern,
    metric: 'provider',
    providerPhase: 'totalMs',
    statistic: 'p50',
    absoluteMs: 1,
    relativePercent: 20,
    blocking: true,
  },
  {
    id: 'cache-hit-provider-p95',
    scenarioPattern: cacheHitPattern,
    metric: 'provider',
    providerPhase: 'totalMs',
    statistic: 'p95',
    absoluteMs: 2,
    relativePercent: 25,
    blocking: false,
  },
  {
    id: 'cache-miss-provider-p50',
    scenarioPattern: /^completion-cache-miss$/,
    metric: 'provider',
    providerPhase: 'totalMs',
    statistic: 'p50',
    absoluteMs: 5,
    relativePercent: 20,
    blocking: true,
  },
  {
    id: 'cache-miss-fetch-p50',
    scenarioPattern: /^completion-cache-miss$/,
    metric: 'provider',
    providerPhase: 'commandFetchMs',
    statistic: 'p50',
    absoluteMs: 5,
    relativePercent: 20,
    blocking: true,
  },
  {
    id: 'edit-provider-p50',
    scenarioPattern: editPattern,
    metric: 'provider',
    providerPhase: 'totalMs',
    statistic: 'p50',
    absoluteMs: 5,
    relativePercent: 20,
    blocking: true,
  },
  {
    id: 'edit-parse-p50',
    scenarioPattern: editPattern,
    metric: 'provider',
    providerPhase: 'parseMs',
    statistic: 'p50',
    absoluteMs: 1,
    relativePercent: 20,
    blocking: true,
  },
  {
    id: 'provider-p95-observation',
    scenarioPattern: /^(completion-cache-miss|completion-after-edit-)/,
    metric: 'provider',
    providerPhase: 'totalMs',
    statistic: 'p95',
    absoluteMs: 10,
    relativePercent: 25,
    blocking: false,
  },
  {
    id: 'provider-event-loop-maximum',
    scenarioPattern: /^(completion|hover)-|^completion-after-edit-/,
    metric: 'maxEventLoopDelayMs',
    statistic: 'maximum',
    absoluteMs: 5,
    relativePercent: 25,
    blocking: false,
  },
];

function metricComparison(
  scenario: ScenarioComparison,
  rule: PerformanceThresholdRule,
): MetricComparison {
  if (rule.metric === 'provider') {
    if (!rule.providerPhase) {
      throw new Error(`Performance rule ${rule.id} is missing providerPhase.`);
    }
    const provider = scenario.provider?.[rule.providerPhase];
    if (!provider) {
      throw new Error(
        `Scenario ${scenario.name} has no provider metric ${rule.providerPhase} for rule ${rule.id}.`,
      );
    }
    return provider;
  }
  return scenario[rule.metric];
}

function metricLabel(rule: PerformanceThresholdRule): string {
  return rule.metric === 'provider'
    ? `provider.${rule.providerPhase}`
    : rule.metric;
}

export function evaluatePerformance(
  report: PerformanceComparisonReport,
  mode: PerformanceGateMode,
  rules: readonly PerformanceThresholdRule[] = defaultPerformanceThresholds,
): PerformanceEvaluation {
  if (report.schemaVersion !== 5 || !Array.isArray(report.comparisons)) {
    throw new Error('Performance comparison report must use schema version 5.');
  }
  const scenarioNames = report.comparisons.map(scenario => scenario.name);
  if (new Set(scenarioNames).size !== scenarioNames.length) {
    throw new Error('Performance comparison report contains duplicate scenarios.');
  }
  for (const required of requiredPerformanceScenarioNames) {
    if (!scenarioNames.includes(required)) {
      throw new Error(`Performance comparison report is missing required scenario ${required}.`);
    }
  }
  const findings: PerformanceFinding[] = [];
  for (const scenario of report.comparisons) {
    for (const rule of rules) {
      rule.scenarioPattern.lastIndex = 0;
      if (!rule.scenarioPattern.test(scenario.name)) {
        continue;
      }
      const comparison = metricComparison(scenario, rule)[rule.statistic];
      const expectedComparisonStatistic = rule.statistic === 'maximum' ? 'maximum' : 'p50';
      if (comparison.comparisonStatistic !== expectedComparisonStatistic) {
        throw new Error(
          `Scenario ${scenario.name} metric ${metricLabel(rule)} ${rule.statistic} must compare `
          + `${expectedComparisonStatistic} across processes.`,
        );
      }
      const exceeded = comparison.differenceMs >= rule.absoluteMs
        && comparison.relativePercent !== null
        && comparison.relativePercent >= rule.relativePercent;
      findings.push({
        ruleId: rule.id,
        scenario: scenario.name,
        metric: metricLabel(rule),
        statistic: rule.statistic,
        baselineMs: comparison.armAValueMs,
        targetMs: comparison.armBValueMs,
        differenceMs: comparison.differenceMs,
        relativePercent: comparison.relativePercent,
        absoluteThresholdMs: rule.absoluteMs,
        relativeThresholdPercent: rule.relativePercent,
        blocking: rule.blocking,
        exceeded,
      });
    }
  }
  const observedRegressionCount = findings.filter(finding => finding.exceeded).length;
  const blockingRegressionCount = findings.filter(
    finding => finding.exceeded && finding.blocking,
  ).length;
  return {
    schemaVersion: 1,
    mode,
    sameSource: report.source.sameSource,
    passed: mode === 'shadow' || report.source.sameSource || blockingRegressionCount === 0,
    blockingRegressionCount,
    observedRegressionCount,
    findings,
  };
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

export function performanceEvaluationMarkdown(
  report: PerformanceComparisonReport,
  evaluation: PerformanceEvaluation,
): string {
  const lines = [
    '# Provider performance comparison',
    '',
    `- Mode: ${evaluation.mode}`,
    `- Comparison: ${report.comparison}`,
    `- VS Code: ${report.vscode.actual}`,
    `- Arm A: ${report.source.armA.sha ?? report.source.armA.digestSha256}`,
    `- Arm B: ${report.source.armB.sha ?? report.source.armB.digestSha256}`,
    `- Result: ${evaluation.passed ? 'pass' : 'fail'}`,
    `- Threshold observations: ${evaluation.observedRegressionCount}`,
    `- Blocking observations: ${evaluation.blockingRegressionCount}`,
    '',
    '| Scenario | Metric | Stat | A (ms) | B (ms) | Diff (ms) | Diff (%) | Limit | Blocking |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const finding of evaluation.findings) {
    const marker = finding.exceeded ? 'exceeded' : 'ok';
    lines.push(
      `| ${finding.scenario} | ${finding.metric} | ${finding.statistic} | `
      + `${formatNumber(finding.baselineMs)} | ${formatNumber(finding.targetMs)} | `
      + `${formatNumber(finding.differenceMs)} | ${formatNumber(finding.relativePercent)} | `
      + `${finding.absoluteThresholdMs} ms + ${finding.relativeThresholdPercent}% (${marker}) | `
      + `${finding.blocking ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  if (evaluation.mode === 'shadow') {
    lines.push('Threshold observations are informational while the CI baseline is being calibrated.');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
