import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

import type { ProviderPhaseTimings } from '../providerPerformance';

type ProcessArm = 'A' | 'B' | 'production';
type PerformanceMode = 'instrumented' | 'production';

const timingKeys: Array<keyof ProviderPhaseTimings> = [
  'totalMs',
  'treeWaitMs',
  'parseMs',
  'treeCopyMs',
  'analysisMs',
  'commandFetchMs',
  'pathResolveMs',
  'unclassifiedMs',
];

interface Distribution {
  minimum: number;
  p50: number;
  p95: number;
  maximum: number;
  mean: number;
}

interface ChildScenarioReport {
  name: string;
  summary: {
    externalTotalMs: Distribution;
    provider: Record<keyof ProviderPhaseTimings, Distribution> | null;
  };
}

interface ChildPerformanceReport {
  schemaVersion: number;
  runtime: {
    vscode: string;
    [key: string]: unknown;
  };
  configuration: Record<string, unknown>;
  sampling: {
    warmupSamples: number;
    samplesPerScenario: number;
    quantileMethod?: string;
  };
  scenarios: ChildScenarioReport[];
  [key: string]: unknown;
}

interface ProcessRun {
  sequence: number;
  arm: ProcessArm;
  mode: PerformanceMode;
  report: ChildPerformanceReport;
}

interface MetricComparison {
  armA: Distribution;
  armB: Distribution;
  p50DifferenceMs: number;
  p50RelativePercent: number | null;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function positiveEvenIntegerEnvironment(name: string, fallback: number): number {
  const value = positiveIntegerEnvironment(name, fallback);
  if (value % 2 !== 0) {
    throw new Error(`${name} must be even so process order can be counterbalanced.`);
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error('Cannot summarize an empty performance sample.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const weight = rank - lowerIndex;
  return sorted[lowerIndex] + ((sorted[upperIndex] - sorted[lowerIndex]) * weight);
}

function distribution(values: readonly number[]): Distribution {
  return {
    minimum: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

function compareMetrics(armAValues: readonly number[], armBValues: readonly number[]): MetricComparison {
  const armA = distribution(armAValues);
  const armB = distribution(armBValues);
  const difference = armB.p50 - armA.p50;
  return {
    armA,
    armB,
    p50DifferenceMs: difference,
    p50RelativePercent: armA.p50 === 0 ? null : (difference / armA.p50) * 100,
  };
}

function javascriptFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...javascriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(absolute);
    }
  }
  return files;
}

function sourceDigest(projectRoot: string): string {
  const files = [
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'package-lock.json'),
    path.join(projectRoot, 'tree-sitter-bash.lock.json'),
    path.join(projectRoot, 'tree-sitter-bash.wasm'),
    ...javascriptFiles(path.join(projectRoot, 'out')),
  ].filter(existsSync).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(projectRoot, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function scenario(run: ProcessRun, name: string): ChildScenarioReport {
  const found = run.report.scenarios.find(candidate => candidate.name === name);
  if (!found) {
    throw new Error(`Process ${run.sequence} did not report scenario ${name}.`);
  }
  return found;
}

function providerP50(run: ProcessRun, scenarioName: string, key: keyof ProviderPhaseTimings): number {
  const provider = scenario(run, scenarioName).summary.provider;
  if (!provider) {
    throw new Error(`Process ${run.sequence} did not record provider timings.`);
  }
  return provider[key].p50;
}

async function runExtensionHost(
  projectRoot: string,
  extensionTestsPath: string,
  sourceDigestSha256: string,
  sequence: number,
  arm: ProcessArm,
  mode: PerformanceMode,
  warmupSamples: number,
  samplesPerScenario: number,
): Promise<ProcessRun> {
  const profileParent = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const profileRoot = mkdtempSync(path.join(profileParent, 'h2o-performance-'));
  const userDataDir = path.join(profileRoot, 'user-data');
  const extensionsDir = path.join(profileRoot, 'extensions');
  const childReportPath = path.join(profileRoot, 'process-report.json');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });

  try {
    await runTests({
      ...(process.env.VSCODE_EXECUTABLE_PATH
        ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH }
        : { version: process.env.VSCODE_VERSION || 'stable' }),
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath,
      launchArgs: [
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-release-notes',
        '--skip-welcome',
        ...(process.env.VSCODE_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      ],
      extensionTestsEnv: {
        ['VSCODE_H2O_PERFORMANCE']: mode === 'instrumented' ? '1' : '0',
        ['VSCODE_H2O_PERFORMANCE_MODE']: mode,
        ['VSCODE_H2O_PERFORMANCE_REPORT']: childReportPath,
        ['VSCODE_H2O_PERFORMANCE_PROCESS_SEQUENCE']: String(sequence),
        ['VSCODE_H2O_PERFORMANCE_PROCESS_ARM']: arm,
        ['VSCODE_H2O_PERFORMANCE_SOURCE_DIGEST']: sourceDigestSha256,
        ['VSCODE_H2O_PERFORMANCE_WARMUP_SAMPLES']: String(warmupSamples),
        ['VSCODE_H2O_PERFORMANCE_SAMPLES']: String(samplesPerScenario),
      },
    });
    if (!existsSync(childReportPath)) {
      throw new Error(`Performance process report was not created at ${childReportPath}`);
    }
    const report = JSON.parse(readFileSync(childReportPath, 'utf8')) as ChildPerformanceReport;
    if (report.schemaVersion !== 2 || !Array.isArray(report.scenarios)) {
      throw new Error(`Performance process ${sequence} returned an invalid report.`);
    }
    return { sequence, arm, mode, report };
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(__dirname, '../../');
  const reportPath = path.resolve(
    process.env.VSCODE_H2O_PERFORMANCE_REPORT
      ?? path.join(projectRoot, 'artifacts', 'provider-performance-noise.json'),
  );
  const extensionTestsPath = path.resolve(__dirname, './performance/index');
  const processesPerArm = positiveEvenIntegerEnvironment(
    'VSCODE_H2O_PERFORMANCE_PROCESSES_PER_ARM',
    2,
  );
  const warmupSamples = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_WARMUP_SAMPLES', 5);
  const samplesPerScenario = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_SAMPLES', 30);
  const digest = sourceDigest(projectRoot);
  const processRuns: ProcessRun[] = [];
  let sequence = 0;

  for (let block = 0; block < processesPerArm / 2; block += 1) {
    for (const arm of ['A', 'B'] as const) {
      processRuns.push(await runExtensionHost(
        projectRoot,
        extensionTestsPath,
        digest,
        ++sequence,
        arm,
        'instrumented',
        warmupSamples,
        samplesPerScenario,
      ));
    }
    processRuns.push(await runExtensionHost(
      projectRoot,
      extensionTestsPath,
      digest,
      ++sequence,
      'production',
      'production',
      warmupSamples,
      samplesPerScenario,
    ));
    for (const arm of ['B', 'A'] as const) {
      processRuns.push(await runExtensionHost(
        projectRoot,
        extensionTestsPath,
        digest,
        ++sequence,
        arm,
        'instrumented',
        warmupSamples,
        samplesPerScenario,
      ));
    }
    processRuns.push(await runExtensionHost(
      projectRoot,
      extensionTestsPath,
      digest,
      ++sequence,
      'production',
      'production',
      warmupSamples,
      samplesPerScenario,
    ));
  }

  const armA = processRuns.filter(run => run.arm === 'A');
  const armB = processRuns.filter(run => run.arm === 'B');
  const instrumented = processRuns.filter(run => run.mode === 'instrumented');
  const production = processRuns.filter(run => run.mode === 'production');
  const scenarioNames = instrumented[0].report.scenarios.map(entry => entry.name);
  const processAA = scenarioNames.map(name => ({
    name,
    externalTotalMs: compareMetrics(
      armA.map(run => scenario(run, name).summary.externalTotalMs.p50),
      armB.map(run => scenario(run, name).summary.externalTotalMs.p50),
    ),
    provider: Object.fromEntries(timingKeys.map(key => [
      key,
      compareMetrics(
        armA.map(run => providerP50(run, name, key)),
        armB.map(run => providerP50(run, name, key)),
      ),
    ])) as Record<keyof ProviderPhaseTimings, MetricComparison>,
  }));
  const measurementOverhead = scenarioNames.map(name => {
    const productionValues = production.map(run => scenario(run, name).summary.externalTotalMs.p50);
    const instrumentedValues = instrumented.map(run => scenario(run, name).summary.externalTotalMs.p50);
    const productionSummary = distribution(productionValues);
    const instrumentedSummary = distribution(instrumentedValues);
    const difference = instrumentedSummary.p50 - productionSummary.p50;
    return {
      name,
      production: productionSummary,
      instrumented: instrumentedSummary,
      p50DifferenceMs: difference,
      p50RelativePercent: productionSummary.p50 === 0
        ? null
        : (difference / productionSummary.p50) * 100,
    };
  });

  const firstReport = processRuns[0].report;
  const cpu = cpus()[0];
  const report = {
    schemaVersion: 3,
    comparison: 'A/A across fresh Extension Host processes in counterbalanced ABBA order',
    generatedAt: new Date().toISOString(),
    source: {
      commit: process.env.VSCODE_H2O_PERFORMANCE_SHA ?? process.env.GITHUB_SHA ?? null,
      digestSha256: digest,
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      cpuModel: cpu?.model ?? null,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    vscode: {
      requested: process.env.VSCODE_EXECUTABLE_PATH
        ? process.env.VSCODE_EXECUTABLE_PATH
        : process.env.VSCODE_VERSION || 'stable',
      actual: firstReport.runtime.vscode,
    },
    configuration: firstReport.configuration,
    sampling: {
      processesPerArm,
      productionProcesses: production.length,
      warmupSamples,
      samplesPerScenario,
      quantileMethod: 'linear-interpolation-rank-n-minus-1',
      processOrder: processRuns.map(run => ({
        sequence: run.sequence,
        arm: run.arm,
        mode: run.mode,
      })),
    },
    processAA,
    measurementOverhead,
    processRuns,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Provider performance process-noise report: ${reportPath}`);
}

void main().catch(error => {
  console.error('Failed to run provider performance noise measurement', error);
  process.exit(1);
});
