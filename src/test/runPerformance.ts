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

import {
  commandCacheSnapshotVersion,
  encodeCommandCacheSnapshot,
  type CommandCacheSnapshot,
} from '../cacheStorage';
import type { Command } from '../command';
import type { ProviderPhaseTimings } from '../providerPerformance';
import {
  createActivationFixtureSnapshot,
  type ActivationProfile,
} from './performance/activationFixture';

type ProcessArm = 'A' | 'B';
type PerformanceMode = 'instrumented' | 'production';
type PerformanceSuite = 'activation' | 'provider';
type ComparedStatistic = 'maximum' | 'p50' | 'p95';

const extensionId = 'tetradresearch.vscode-h2o';
const providerTimingKeys: Array<keyof ProviderPhaseTimings> = [
  'totalMs',
  'treeWaitMs',
  'parseMs',
  'treeCopyMs',
  'analysisMs',
  'commandFetchMs',
  'pathResolveMs',
  'unclassifiedMs',
];
const comparedStatistics: ComparedStatistic[] = ['p50', 'p95', 'maximum'];
const activationProfiles: ActivationProfile[] = ['empty', 'general', 'general-bio'];
const providerScenarioNames = [
  'completion-cache-hit',
  'hover-cache-hit',
  'completion-cache-miss',
  'completion-after-edit-10240',
  'completion-after-edit-102400',
  'completion-after-edit-1048576',
] as const;
const expectedScenarioNames = [
  'cold-activation-empty',
  ...providerScenarioNames,
  'cold-activation-general',
  'cold-activation-general-bio',
] as const;

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
    maxEventLoopDelayMs: Distribution;
    provider: Record<keyof ProviderPhaseTimings, Distribution> | null;
  };
}

interface ChildPerformanceReport {
  schemaVersion: number;
  generatedAt: string;
  process: {
    sequence: number;
    arm: ProcessArm;
    mode: PerformanceMode;
    suite: PerformanceSuite;
    activationProfile: ActivationProfile;
  };
  source: {
    sha: string | null;
    digestSha256: string | null;
  };
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
}

interface SourceRoot {
  root: string;
  sha: string | null;
  digestSha256: string;
}

interface PreparedActivationFixture {
  profile: ActivationProfile;
  commandCount: number;
  jsonBytes: number;
  compressedBytes: number;
  content: Buffer | null;
}

interface ProcessRun {
  sequence: number;
  arm: ProcessArm;
  mode: PerformanceMode;
  suite: PerformanceSuite;
  activationProfile: ActivationProfile;
  source: SourceRoot;
  report: ChildPerformanceReport;
}

interface ValueComparison {
  armA: Distribution;
  armB: Distribution;
  comparisonStatistic: 'maximum' | 'p50';
  armAValueMs: number;
  armBValueMs: number;
  differenceMs: number;
  relativePercent: number | null;
}

type MetricComparison = Record<ComparedStatistic, ValueComparison>;

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

function compareValues(
  armAValues: readonly number[],
  armBValues: readonly number[],
  comparisonStatistic: 'maximum' | 'p50',
): ValueComparison {
  const armA = distribution(armAValues);
  const armB = distribution(armBValues);
  const armAValueMs = armA[comparisonStatistic];
  const armBValueMs = armB[comparisonStatistic];
  const differenceMs = armBValueMs - armAValueMs;
  return {
    armA,
    armB,
    comparisonStatistic,
    armAValueMs,
    armBValueMs,
    differenceMs,
    relativePercent: armAValueMs === 0 ? null : (differenceMs / armAValueMs) * 100,
  };
}

function compareMetric(
  armA: readonly ProcessRun[],
  armB: readonly ProcessRun[],
  value: (run: ProcessRun) => Distribution,
): MetricComparison {
  return Object.fromEntries(comparedStatistics.map(statistic => [
    statistic,
    compareValues(
      armA.map(run => value(run)[statistic]),
      armB.map(run => value(run)[statistic]),
      statistic === 'maximum' ? 'maximum' : 'p50',
    ),
  ])) as MetricComparison;
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
  if (files.length === 0) {
    throw new Error(`No performance source files were found below ${projectRoot}.`);
  }
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(projectRoot, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sourceRoot(rootEnvironment: string, shaEnvironment: string, fallbackRoot: string): SourceRoot {
  const root = path.resolve(process.env[rootEnvironment] ?? fallbackRoot);
  const extensionEntry = path.join(root, 'out/extension.js');
  if (!existsSync(extensionEntry)) {
    throw new Error(`${rootEnvironment} has no compiled extension at ${extensionEntry}.`);
  }
  return {
    root,
    sha: process.env[shaEnvironment] ?? null,
    digestSha256: sourceDigest(root),
  };
}

function providerFixtureCommand(): Command {
  return {
    name: 'git',
    description: 'Deterministic provider performance fixture',
    options: [{
      names: ['--version'],
      argument: '',
      description: 'Display version information',
    }],
  };
}

async function prepareFixture(
  suite: PerformanceSuite,
  profile: ActivationProfile,
): Promise<PreparedActivationFixture> {
  let snapshot: CommandCacheSnapshot;
  let jsonBytes: number;
  if (suite === 'provider') {
    snapshot = {
      version: commandCacheSnapshotVersion,
      commands: [providerFixtureCommand()],
    };
    jsonBytes = Buffer.byteLength(JSON.stringify(snapshot));
  } else if (profile === 'empty') {
    return {
      profile,
      commandCount: 0,
      jsonBytes: 0,
      compressedBytes: 0,
      content: null,
    };
  } else {
    ({ snapshot, jsonBytes } = createActivationFixtureSnapshot(profile));
  }

  const compressed = await encodeCommandCacheSnapshot(snapshot);
  return {
    profile,
    commandCount: snapshot.commands.length,
    jsonBytes,
    compressedBytes: compressed.length,
    content: compressed,
  };
}

function scenario(run: ProcessRun, name: string): ChildScenarioReport {
  const found = run.report.scenarios.find(candidate => candidate.name === name);
  if (!found) {
    throw new Error(`Process ${run.sequence} did not report scenario ${name}.`);
  }
  return found;
}

function providerDistribution(
  run: ProcessRun,
  scenarioName: string,
  key: keyof ProviderPhaseTimings,
): Distribution {
  const provider = scenario(run, scenarioName).summary.provider;
  if (!provider) {
    throw new Error(`Process ${run.sequence} did not record provider timings.`);
  }
  return provider[key];
}

function scenarioRuns(
  runs: readonly ProcessRun[],
  name: string,
  mode: PerformanceMode,
): ProcessRun[] {
  const expectedSuite: PerformanceSuite = name.startsWith('cold-activation-')
    ? 'activation'
    : 'provider';
  return runs.filter(run => run.suite === expectedSuite
    && run.mode === mode
    && run.report.scenarios.some(candidate => candidate.name === name));
}

async function runExtensionHost(
  sequence: number,
  arm: ProcessArm,
  mode: PerformanceMode,
  suite: PerformanceSuite,
  activationProfile: ActivationProfile,
  source: SourceRoot,
  extensionTestsPath: string,
  activationFixture: PreparedActivationFixture,
  warmupSamples: number,
  samplesPerScenario: number,
): Promise<ProcessRun> {
  const profileParent = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const profileRoot = mkdtempSync(path.join(profileParent, 'h2o-performance-'));
  const userDataDir = path.join(profileRoot, 'user-data');
  const extensionsDir = path.join(profileRoot, 'extensions');
  const childReportPath = path.join(profileRoot, 'process-report.json');
  const globalStorageDirectory = path.join(
    userDataDir,
    'User',
    'globalStorage',
    extensionId,
  );
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  if (activationFixture.profile !== activationProfile) {
    throw new Error(`Prepared fixture profile does not match ${activationProfile}.`);
  }
  if (activationFixture.content) {
    mkdirSync(globalStorageDirectory, { recursive: true });
    writeFileSync(
      path.join(globalStorageDirectory, 'commands-v1.json.gz'),
      activationFixture.content,
    );
  }

  try {
    await runTests({
      ...(process.env.VSCODE_EXECUTABLE_PATH
        ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH }
        : { version: process.env.VSCODE_VERSION || 'stable' }),
      extensionDevelopmentPath: source.root,
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
        ['VSCODE_H2O_PERFORMANCE_FIXTURE']: '1',
        ['VSCODE_H2O_PERFORMANCE_MODE']: mode,
        ['VSCODE_H2O_PERFORMANCE_SUITE']: suite,
        ['VSCODE_H2O_PERFORMANCE_ACTIVATION_PROFILE']: activationProfile,
        ['VSCODE_H2O_PERFORMANCE_ACTIVATION_COMMAND_COUNT']: String(
          activationFixture.commandCount,
        ),
        ['VSCODE_H2O_PERFORMANCE_ACTIVATION_JSON_BYTES']: String(activationFixture.jsonBytes),
        ['VSCODE_H2O_PERFORMANCE_ACTIVATION_COMPRESSED_BYTES']: String(
          activationFixture.compressedBytes,
        ),
        ['VSCODE_H2O_PERFORMANCE_REPORT']: childReportPath,
        ['VSCODE_H2O_PERFORMANCE_PROCESS_SEQUENCE']: String(sequence),
        ['VSCODE_H2O_PERFORMANCE_PROCESS_ARM']: arm,
        ['VSCODE_H2O_PERFORMANCE_SOURCE_SHA']: source.sha ?? '',
        ['VSCODE_H2O_PERFORMANCE_SOURCE_DIGEST']: source.digestSha256,
        ['VSCODE_H2O_PERFORMANCE_WARMUP_SAMPLES']: String(warmupSamples),
        ['VSCODE_H2O_PERFORMANCE_SAMPLES']: String(samplesPerScenario),
      },
    });
    if (!existsSync(childReportPath)) {
      throw new Error(`Performance process report was not created at ${childReportPath}`);
    }
    const report = JSON.parse(readFileSync(childReportPath, 'utf8')) as ChildPerformanceReport;
    if (report.schemaVersion !== 3 || !Array.isArray(report.scenarios)) {
      throw new Error(`Performance process ${sequence} returned an invalid report.`);
    }
    if (report.source.digestSha256 !== source.digestSha256) {
      throw new Error(`Performance process ${sequence} reported the wrong source digest.`);
    }
    return { sequence, arm, mode, suite, activationProfile, source, report };
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
}

function scenarioComparison(
  name: string,
  armA: readonly ProcessRun[],
  armB: readonly ProcessRun[],
): {
  name: string;
  processSamplesPerArm: number;
  externalTotalMs: MetricComparison;
  maxEventLoopDelayMs: MetricComparison;
  provider: Record<keyof ProviderPhaseTimings, MetricComparison> | null;
} {
  const externalArmA = scenarioRuns(armA, name, 'production');
  const externalArmB = scenarioRuns(armB, name, 'production');
  if (externalArmA.length === 0 || externalArmA.length !== externalArmB.length) {
    throw new Error(
      `Scenario ${name} must have the same non-zero production process count in both arms.`,
    );
  }
  const hasProvider = !name.startsWith('cold-activation-');
  const providerArmA = hasProvider ? scenarioRuns(armA, name, 'instrumented') : [];
  const providerArmB = hasProvider ? scenarioRuns(armB, name, 'instrumented') : [];
  if (hasProvider
    && (providerArmA.length === 0 || providerArmA.length !== providerArmB.length)) {
    throw new Error(
      `Scenario ${name} must have the same non-zero instrumented process count in both arms.`,
    );
  }
  if ([...providerArmA, ...providerArmB].some(
    run => scenario(run, name).summary.provider === null,
  )) {
    throw new Error(`Scenario ${name} is missing instrumented provider timings.`);
  }
  return {
    name,
    processSamplesPerArm: externalArmA.length,
    externalTotalMs: compareMetric(
      externalArmA,
      externalArmB,
      run => scenario(run, name).summary.externalTotalMs,
    ),
    maxEventLoopDelayMs: compareMetric(
      externalArmA,
      externalArmB,
      run => scenario(run, name).summary.maxEventLoopDelayMs,
    ),
    provider: hasProvider
      ? Object.fromEntries(providerTimingKeys.map(key => [
        key,
        compareMetric(
          providerArmA,
          providerArmB,
          run => providerDistribution(run, name, key),
        ),
      ])) as Record<keyof ProviderPhaseTimings, MetricComparison>
      : null,
  };
}

async function main(): Promise<void> {
  const orchestratorRoot = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.join(orchestratorRoot, 'out/test/performance/index');
  if (!existsSync(`${extensionTestsPath}.js`)) {
    throw new Error(`The orchestrator performance harness is missing at ${extensionTestsPath}.js.`);
  }
  const reportPath = path.resolve(
    process.env.VSCODE_H2O_PERFORMANCE_REPORT
      ?? path.join(orchestratorRoot, 'artifacts', 'provider-performance.json'),
  );
  const armA = sourceRoot(
    'VSCODE_H2O_PERFORMANCE_ARM_A_ROOT',
    'VSCODE_H2O_PERFORMANCE_ARM_A_SHA',
    orchestratorRoot,
  );
  const armB = sourceRoot(
    'VSCODE_H2O_PERFORMANCE_ARM_B_ROOT',
    'VSCODE_H2O_PERFORMANCE_ARM_B_SHA',
    orchestratorRoot,
  );
  const processesPerArm = positiveEvenIntegerEnvironment(
    'VSCODE_H2O_PERFORMANCE_PROCESSES_PER_ARM',
    2,
  );
  const activationProcessesPerArm = positiveEvenIntegerEnvironment(
    'VSCODE_H2O_PERFORMANCE_ACTIVATION_PROCESSES_PER_ARM',
    2,
  );
  const warmupSamples = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_WARMUP_SAMPLES', 5);
  const samplesPerScenario = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_SAMPLES', 30);
  const providerFixture = await prepareFixture('provider', 'empty');
  const activationFixtures = new Map<ActivationProfile, PreparedActivationFixture>(
    await Promise.all(activationProfiles.map(async profile => [
      profile,
      await prepareFixture('activation', profile),
    ] as const)),
  );
  const processRuns: ProcessRun[] = [];
  let sequence = 0;

  for (let block = 0; block < processesPerArm / 2; block += 1) {
    for (const [arm, mode, source] of [
      ['A', 'instrumented', armA],
      ['B', 'instrumented', armB],
      ['B', 'production', armB],
      ['A', 'production', armA],
      ['A', 'production', armA],
      ['B', 'production', armB],
      ['B', 'instrumented', armB],
      ['A', 'instrumented', armA],
    ] as const) {
      processRuns.push(await runExtensionHost(
        ++sequence,
        arm,
        mode,
        'provider',
        'empty',
        source,
        extensionTestsPath,
        providerFixture,
        warmupSamples,
        samplesPerScenario,
      ));
    }
  }

  for (const activationProfile of activationProfiles) {
    for (let block = 0; block < activationProcessesPerArm / 2; block += 1) {
      const activationFixture = activationFixtures.get(activationProfile);
      if (!activationFixture) {
        throw new Error(`No prepared activation fixture for ${activationProfile}.`);
      }
      for (const [arm, source] of [
        ['A', armA],
        ['B', armB],
        ['B', armB],
        ['A', armA],
      ] as const) {
        processRuns.push(await runExtensionHost(
          ++sequence,
          arm,
          'production',
          'activation',
          activationProfile,
          source,
          extensionTestsPath,
          activationFixture,
          warmupSamples,
          samplesPerScenario,
        ));
      }
    }
  }

  const armARuns = processRuns.filter(run => run.arm === 'A');
  const armBRuns = processRuns.filter(run => run.arm === 'B');
  const providerArmB = armBRuns.filter(run => run.suite === 'provider');
  const providerArmBInstrumented = providerArmB.filter(run => run.mode === 'instrumented');
  const providerArmBProduction = providerArmB.filter(run => run.mode === 'production');
  const comparisons = expectedScenarioNames.map(
    name => scenarioComparison(name, armARuns, armBRuns),
  );
  const measurementOverhead = providerScenarioNames.map(name => ({
    name,
    externalTotalMs: compareMetric(
      providerArmBProduction,
      providerArmBInstrumented,
      run => scenario(run, name).summary.externalTotalMs,
    ),
    maxEventLoopDelayMs: compareMetric(
      providerArmBProduction,
      providerArmBInstrumented,
      run => scenario(run, name).summary.maxEventLoopDelayMs,
    ),
  }));

  const firstReport = processRuns[0].report;
  const expectedVscode = firstReport.runtime.vscode;
  if (processRuns.some(run => run.report.runtime.vscode !== expectedVscode)) {
    throw new Error('All performance processes must use the same VS Code version.');
  }
  if (!process.env.VSCODE_EXECUTABLE_PATH
    && process.env.VSCODE_VERSION
    && expectedVscode !== process.env.VSCODE_VERSION) {
    throw new Error(
      `Requested VS Code ${process.env.VSCODE_VERSION}, but the processes reported ${expectedVscode}.`,
    );
  }
  const cpu = cpus()[0];
  const sameSource = armA.digestSha256 === armB.digestSha256;
  const report = {
    schemaVersion: 5,
    comparison: sameSource
      ? 'A/A across fresh Extension Host processes in counterbalanced order'
      : 'base/target across fresh Extension Host processes in counterbalanced order',
    generatedAt: new Date().toISOString(),
    source: {
      armA,
      armB,
      sameSource,
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
      actual: expectedVscode,
    },
    sampling: {
      providerInstrumentedProcessesPerArm: processesPerArm,
      providerProductionProcessesPerArm: processesPerArm,
      activationProcessesPerArm,
      warmupSamples,
      samplesPerScenario,
      quantileMethod: 'linear-interpolation-rank-n-minus-1',
      processOrder: processRuns.map(run => ({
        sequence: run.sequence,
        arm: run.arm,
        mode: run.mode,
        suite: run.suite,
        activationProfile: run.activationProfile,
        digestSha256: run.source.digestSha256,
      })),
    },
    comparisons,
    measurementOverhead,
    processRuns,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Provider performance comparison report: ${reportPath}`);
}

void main().catch(error => {
  console.error('Failed to run provider performance comparison', error);
  process.exit(1);
});
