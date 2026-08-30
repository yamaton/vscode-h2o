import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  evaluatePerformance,
  performanceEvaluationMarkdown,
  type PerformanceComparisonReport,
  type PerformanceGateMode,
} from './performance/evaluator';

function gateMode(): PerformanceGateMode {
  const value = process.env.VSCODE_H2O_PERFORMANCE_GATE_MODE ?? 'shadow';
  if (value !== 'shadow' && value !== 'enforce') {
    throw new Error('VSCODE_H2O_PERFORMANCE_GATE_MODE must be shadow or enforce.');
  }
  return value;
}

function main(): void {
  const projectRoot = path.resolve(__dirname, '../../');
  const reportPath = path.resolve(
    process.env.VSCODE_H2O_PERFORMANCE_REPORT
      ?? path.join(projectRoot, 'artifacts', 'provider-performance.json'),
  );
  const evaluationPath = path.resolve(
    process.env.VSCODE_H2O_PERFORMANCE_EVALUATION
      ?? path.join(projectRoot, 'artifacts', 'provider-performance-evaluation.json'),
  );
  const summaryPath = path.resolve(
    process.env.VSCODE_H2O_PERFORMANCE_SUMMARY
      ?? path.join(projectRoot, 'artifacts', 'provider-performance-summary.md'),
  );
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as PerformanceComparisonReport;
  const evaluation = evaluatePerformance(report, gateMode());
  const summary = performanceEvaluationMarkdown(report, evaluation);
  mkdirSync(path.dirname(evaluationPath), { recursive: true });
  mkdirSync(path.dirname(summaryPath), { recursive: true });
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8');
  writeFileSync(summaryPath, summary, 'utf8');
  console.log(summary);
  if (!evaluation.passed) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error('Failed to evaluate provider performance', error);
  process.exitCode = 1;
}
