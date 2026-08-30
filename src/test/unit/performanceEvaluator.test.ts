import * as assert from 'assert';

import {
  evaluatePerformance,
  performanceEvaluationMarkdown,
  requiredPerformanceScenarioNames,
  type MetricComparison,
  type PerformanceComparisonReport,
  type PerformanceThresholdRule,
} from '../performance/evaluator';

function metric(baselineMs: number, targetMs: number): MetricComparison {
  const comparison = {
    armA: {
      minimum: baselineMs,
      p50: baselineMs,
      p95: baselineMs,
      maximum: baselineMs,
      mean: baselineMs,
    },
    armB: {
      minimum: targetMs,
      p50: targetMs,
      p95: targetMs,
      maximum: targetMs,
      mean: targetMs,
    },
    comparisonStatistic: 'p50' as const,
    armAValueMs: baselineMs,
    armBValueMs: targetMs,
    differenceMs: targetMs - baselineMs,
    relativePercent: baselineMs === 0 ? null : ((targetMs - baselineMs) / baselineMs) * 100,
  };
  return { p50: comparison, p95: comparison, maximum: comparison };
}

function report(baselineMs: number, targetMs: number, sameSource = false): PerformanceComparisonReport {
  return {
    schemaVersion: 5,
    comparison: sameSource ? 'A/A' : 'base/target',
    generatedAt: '2026-08-29T00:00:00.000Z',
    source: {
      sameSource,
      armA: { sha: 'base', digestSha256: 'a' },
      armB: { sha: 'target', digestSha256: sameSource ? 'a' : 'b' },
    },
    vscode: { requested: '1.135.0', actual: '1.135.0' },
    comparisons: requiredPerformanceScenarioNames.map(name => ({
      name,
      externalTotalMs: metric(baselineMs, targetMs),
      maxEventLoopDelayMs: metric(0.1, 0.1),
      provider: name.startsWith('cold-activation-')
        ? null
        : { totalMs: metric(baselineMs, targetMs) },
    })),
  };
}

const rule: PerformanceThresholdRule = {
  id: 'test-rule',
  scenarioPattern: /^completion-cache-hit$/,
  metric: 'provider',
  providerPhase: 'totalMs',
  statistic: 'p50',
  absoluteMs: 5,
  relativePercent: 20,
  blocking: true,
};

suite('performance evaluator', () => {
  test('requires both the absolute and relative threshold', () => {
    const absoluteOnly = evaluatePerformance(report(100, 106), 'enforce', [rule]);
    assert.strictEqual(absoluteOnly.findings[0].exceeded, false);
    assert.strictEqual(absoluteOnly.passed, true);

    const relativeOnly = evaluatePerformance(report(10, 13), 'enforce', [rule]);
    assert.strictEqual(relativeOnly.findings[0].exceeded, false);
    assert.strictEqual(relativeOnly.passed, true);

    const both = evaluatePerformance(report(20, 26), 'enforce', [rule]);
    assert.strictEqual(both.findings[0].exceeded, true);
    assert.strictEqual(both.blockingRegressionCount, 1);
    assert.strictEqual(both.passed, false);
  });

  test('keeps threshold violations informational in shadow and A/A modes', () => {
    const shadow = evaluatePerformance(report(20, 26), 'shadow', [rule]);
    assert.strictEqual(shadow.observedRegressionCount, 1);
    assert.strictEqual(shadow.passed, true);

    const aa = evaluatePerformance(report(20, 26, true), 'enforce', [rule]);
    assert.strictEqual(aa.observedRegressionCount, 1);
    assert.strictEqual(aa.passed, true);
  });

  test('does not classify improvements as regressions', () => {
    const evaluation = evaluatePerformance(report(20, 10), 'enforce', [rule]);
    assert.strictEqual(evaluation.findings[0].exceeded, false);
    assert.strictEqual(evaluation.passed, true);
  });

  test('uses the largest process maximum for maximum rules', () => {
    const comparison = report(20, 20);
    const cacheHit = comparison.comparisons.find(
      scenario => scenario.name === 'completion-cache-hit',
    );
    assert.ok(cacheHit);
    cacheHit.maxEventLoopDelayMs.maximum = {
      armA: { minimum: 1, p50: 2, p95: 9, maximum: 10, mean: 4 },
      armB: { minimum: 1, p50: 2, p95: 19, maximum: 20, mean: 7 },
      comparisonStatistic: 'maximum',
      armAValueMs: 10,
      armBValueMs: 20,
      differenceMs: 10,
      relativePercent: 100,
    };
    const maximumRule: PerformanceThresholdRule = {
      id: 'maximum-rule',
      scenarioPattern: /^completion-cache-hit$/,
      metric: 'maxEventLoopDelayMs',
      statistic: 'maximum',
      absoluteMs: 5,
      relativePercent: 20,
      blocking: true,
    };
    const evaluation = evaluatePerformance(comparison, 'enforce', [maximumRule]);
    assert.strictEqual(evaluation.findings[0].baselineMs, 10);
    assert.strictEqual(evaluation.findings[0].targetMs, 20);
    assert.strictEqual(evaluation.passed, false);
  });

  test('rejects incompatible reports and missing provider metrics', () => {
    const incompatible = report(20, 26);
    incompatible.schemaVersion = 4;
    assert.throws(
      () => evaluatePerformance(incompatible, 'shadow', [rule]),
      /schema version 5/,
    );

    const missing = report(20, 26);
    const cacheHit = missing.comparisons.find(
      scenario => scenario.name === 'completion-cache-hit',
    );
    assert.ok(cacheHit);
    cacheHit.provider = null;
    assert.throws(
      () => evaluatePerformance(missing, 'shadow', [rule]),
      /has no provider metric totalMs/,
    );

    const missingScenario = report(20, 26);
    missingScenario.comparisons = missingScenario.comparisons.filter(
      scenario => scenario.name !== 'completion-cache-miss',
    );
    assert.throws(
      () => evaluatePerformance(missingScenario, 'enforce', [rule]),
      /missing required scenario completion-cache-miss/,
    );
  });

  test('renders a markdown summary with source identity and thresholds', () => {
    const comparison = report(20, 26);
    const evaluation = evaluatePerformance(comparison, 'shadow', [rule]);
    const markdown = performanceEvaluationMarkdown(comparison, evaluation);
    assert.match(markdown, /Mode: shadow/);
    assert.match(markdown, /Arm A: base/);
    assert.match(markdown, /5 ms \+ 20% \(exceeded\)/);
    assert.match(markdown, /informational/);
  });
});
