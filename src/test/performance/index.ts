import * as assert from 'assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';

import type {
  ProviderPerformanceKind,
  ProviderPerformanceSample,
  ProviderPhaseTimings,
} from '../../providerPerformance';
import {
  type ActivationProfile,
} from './activationFixture';

const extensionId = 'tetradresearch.vscode-h2o';
const eventLoopProbeIntervalMs = 2;
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

type PerformanceSuite = 'activation' | 'provider';
type ScenarioKind = ProviderPerformanceKind | 'activation';

interface Distribution {
  minimum: number;
  p50: number;
  p95: number;
  maximum: number;
  mean: number;
}

interface TimedOperation {
  elapsedMs: number;
  maxEventLoopDelayMs: number;
}

interface TimedValue<T> extends TimedOperation {
  value: T;
}

interface ScenarioObservation {
  externalTotalMs: number;
  maxEventLoopDelayMs: number;
  provider: ProviderPerformanceSample | null;
}

interface ScenarioReport {
  name: string;
  kind: ScenarioKind;
  expectedOutcome: string;
  documentCharacters: number | null;
  observations: ScenarioObservation[];
  summary: {
    externalTotalMs: Distribution;
    maxEventLoopDelayMs: Distribution;
    provider: Record<keyof ProviderPhaseTimings, Distribution> | null;
  };
}

interface ActivationFixture {
  profile: ActivationProfile;
  commandCount: number;
  jsonBytes: number;
  compressedBytes: number;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

function nonNegativeIntegerEnvironment(name: string): number {
  const value = Number(process.env[name]);
  assert.ok(Number.isInteger(value) && value >= 0, `${name} must be a non-negative integer`);
  return value;
}

function activationFixture(profile: ActivationProfile): ActivationFixture {
  return {
    profile,
    commandCount: nonNegativeIntegerEnvironment(
      'VSCODE_H2O_PERFORMANCE_ACTIVATION_COMMAND_COUNT',
    ),
    jsonBytes: nonNegativeIntegerEnvironment('VSCODE_H2O_PERFORMANCE_ACTIVATION_JSON_BYTES'),
    compressedBytes: nonNegativeIntegerEnvironment(
      'VSCODE_H2O_PERFORMANCE_ACTIVATION_COMPRESSED_BYTES',
    ),
  };
}

function sourceWithCharacters(characters: number, commandName = 'git'): string {
  const suffix = `\n${commandName} --`;
  assert.ok(characters > suffix.length + 3);
  const prefix = '# a performance fixture\n';
  const bodyLength = characters - suffix.length;
  const repeats = Math.ceil(bodyLength / prefix.length);
  return prefix.repeat(repeats).slice(0, bodyLength) + suffix;
}

function percentile(values: readonly number[], fraction: number): number {
  assert.ok(values.length > 0);
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

function summarizeProvider(
  samples: readonly ProviderPerformanceSample[],
): Record<keyof ProviderPhaseTimings, Distribution> {
  return Object.fromEntries(timingKeys.map(key => [
    key,
    distribution(samples.map(sample => sample.timings[key])),
  ])) as Record<keyof ProviderPhaseTimings, Distribution>;
}

async function measureWithEventLoopDelay<T>(operation: () => PromiseLike<T>): Promise<TimedValue<T>> {
  let maximumDelayMs = 0;
  let expectedAt = performance.now() + eventLoopProbeIntervalMs;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = (): void => {
    const observedAt = performance.now();
    maximumDelayMs = Math.max(maximumDelayMs, observedAt - expectedAt);
    if (active) {
      expectedAt = observedAt + eventLoopProbeIntervalMs;
      timer = setTimeout(tick, eventLoopProbeIntervalMs);
    }
  };
  timer = setTimeout(tick, eventLoopProbeIntervalMs);
  const startedAt = performance.now();
  try {
    const value = await operation();
    const elapsedMs = performance.now() - startedAt;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    return { value, elapsedMs, maxEventLoopDelayMs: maximumDelayMs };
  } finally {
    active = false;
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function performanceSamples(): Promise<ProviderPerformanceSample[]> {
  const samples = await vscode.commands.executeCommand<ProviderPerformanceSample[]>(
    'h2o.getProviderPerformanceSamples',
  );
  assert.ok(Array.isArray(samples), 'provider performance recording must be enabled');
  return samples;
}

async function clearPerformanceSamples(): Promise<void> {
  await vscode.commands.executeCommand('h2o.clearProviderPerformanceSamples');
}

async function collectScenario(
  name: string,
  kind: ProviderPerformanceKind,
  expectedOutcome: string,
  documentCharacters: number,
  recordingEnabled: boolean,
  warmupSamples: number,
  samplesPerScenario: number,
  operation: () => Promise<TimedOperation>,
): Promise<ScenarioReport> {
  if (recordingEnabled) {
    await clearPerformanceSamples();
  }
  for (let index = 0; index < warmupSamples; index += 1) {
    await operation();
  }

  if (recordingEnabled) {
    await clearPerformanceSamples();
  }
  const timings: TimedOperation[] = [];
  for (let index = 0; index < samplesPerScenario; index += 1) {
    timings.push(await operation());
  }

  const providerSamples = recordingEnabled
    ? (await performanceSamples()).filter(sample => sample.kind === kind)
    : [];
  if (recordingEnabled) {
    assert.strictEqual(
      providerSamples.length,
      samplesPerScenario,
      `${name} must emit exactly one ${kind} sample per request`,
    );
    assert.ok(
      providerSamples.every(sample => sample.outcome === expectedOutcome),
      `${name} must finish with outcome ${expectedOutcome}`,
    );
  }

  const observations = timings.map((timing, index) => ({
    externalTotalMs: timing.elapsedMs,
    maxEventLoopDelayMs: timing.maxEventLoopDelayMs,
    provider: providerSamples[index] ?? null,
  }));
  return {
    name,
    kind,
    expectedOutcome,
    documentCharacters,
    observations,
    summary: {
      externalTotalMs: distribution(timings.map(timing => timing.elapsedMs)),
      maxEventLoopDelayMs: distribution(timings.map(timing => timing.maxEventLoopDelayMs)),
      provider: recordingEnabled ? summarizeProvider(providerSamples) : null,
    },
  };
}

async function executeCompletion(document: vscode.TextDocument): Promise<TimedOperation> {
  const measured = await measureWithEventLoopDelay(() => vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    document.positionAt(document.getText().length),
  ));
  assert.ok(measured.value.items.some(item => {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    return label === '--version';
  }));
  return measured;
}

async function executeHover(document: vscode.TextDocument): Promise<TimedOperation> {
  const commandOffset = document.getText().lastIndexOf('git');
  const measured = await measureWithEventLoopDelay(() => vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    document.uri,
    document.positionAt(commandOffset + 1),
  ));
  assert.ok(measured.value.length > 0);
  return measured;
}

async function replaceFixtureMarker(document: vscode.TextDocument, marker: 'a' | 'b'): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(2), document.positionAt(3)),
    marker,
  );
  assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
}

async function editFixtureRoundTrip(document: vscode.TextDocument): Promise<void> {
  await replaceFixtureMarker(document, 'b');
  await replaceFixtureMarker(document, 'a');
}

async function runParseScenario(
  characters: number,
  recordingEnabled: boolean,
  warmupSamples: number,
  samplesPerScenario: number,
): Promise<ScenarioReport> {
  const document = await vscode.workspace.openTextDocument({
    language: 'shellscript',
    content: sourceWithCharacters(characters),
  });
  await vscode.window.showTextDocument(document, { preview: false });
  await executeCompletion(document);
  return collectScenario(
    `completion-after-edit-${characters}`,
    'completion',
    'items',
    characters,
    recordingEnabled,
    warmupSamples,
    samplesPerScenario,
    async () => {
      await editFixtureRoundTrip(document);
      return executeCompletion(document);
    },
  );
}

async function runCacheHitScenario(
  kind: ProviderPerformanceKind,
  recordingEnabled: boolean,
  warmupSamples: number,
  samplesPerScenario: number,
): Promise<ScenarioReport> {
  const characters = 10 * 1024;
  const document = await vscode.workspace.openTextDocument({
    language: 'shellscript',
    content: sourceWithCharacters(characters),
  });
  await vscode.window.showTextDocument(document, { preview: false });
  const operation = kind === 'completion'
    ? () => executeCompletion(document)
    : () => executeHover(document);
  await operation();
  return collectScenario(
    `${kind}-cache-hit`,
    kind,
    kind === 'completion' ? 'items' : 'hover',
    characters,
    recordingEnabled,
    warmupSamples,
    samplesPerScenario,
    operation,
  );
}

async function runCacheMissScenario(
  recordingEnabled: boolean,
  warmupSamples: number,
  samplesPerScenario: number,
): Promise<ScenarioReport> {
  const commandName = 'fixture-miss';
  const characters = 10 * 1024;
  const document = await vscode.workspace.openTextDocument({
    language: 'shellscript',
    content: sourceWithCharacters(characters, commandName),
  });
  await vscode.window.showTextDocument(document, { preview: false });
  const operation = async (): Promise<TimedOperation> => {
    await vscode.commands.executeCommand('h2o.clearPerformanceCommandCache', commandName);
    return executeCompletion(document);
  };
  return collectScenario(
    'completion-cache-miss',
    'completion',
    'items',
    characters,
    recordingEnabled,
    warmupSamples,
    samplesPerScenario,
    operation,
  );
}

function activationScenario(
  profile: ActivationProfile,
  timing: TimedOperation,
): ScenarioReport {
  const observations = [{
    externalTotalMs: timing.elapsedMs,
    maxEventLoopDelayMs: timing.maxEventLoopDelayMs,
    provider: null,
  }];
  return {
    name: `cold-activation-${profile}`,
    kind: 'activation',
    expectedOutcome: 'activated',
    documentCharacters: null,
    observations,
    summary: {
      externalTotalMs: distribution([timing.elapsedMs]),
      maxEventLoopDelayMs: distribution([timing.maxEventLoopDelayMs]),
      provider: null,
    },
  };
}

export async function run(): Promise<void> {
  const reportPath = process.env.VSCODE_H2O_PERFORMANCE_REPORT;
  assert.ok(reportPath, 'VSCODE_H2O_PERFORMANCE_REPORT is required');
  const mode = process.env.VSCODE_H2O_PERFORMANCE_MODE;
  assert.ok(mode === 'instrumented' || mode === 'production', 'performance mode is required');
  const suite = process.env.VSCODE_H2O_PERFORMANCE_SUITE as PerformanceSuite;
  assert.ok(suite === 'activation' || suite === 'provider', 'performance suite is required');
  const activationProfile = process.env.VSCODE_H2O_PERFORMANCE_ACTIVATION_PROFILE as ActivationProfile;
  assert.ok(
    activationProfile === 'empty'
      || activationProfile === 'general'
      || activationProfile === 'general-bio',
    'activation profile is required',
  );
  const recordingEnabled = mode === 'instrumented';
  assert.strictEqual(process.env.VSCODE_H2O_PERFORMANCE === '1', recordingEnabled);
  assert.ok(suite !== 'activation' || !recordingEnabled, 'activation suite must use production mode');
  const warmupSamples = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_WARMUP_SAMPLES', 5);
  const samplesPerScenario = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_SAMPLES', 30);
  const preparedActivationFixture = activationFixture(activationProfile);

  try {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `${extensionId} must be installed in the Extension Host`);
    await vscode.workspace.getConfiguration('shellCompletion').update(
      'scanUnknownCommands',
      true,
      vscode.ConfigurationTarget.Global,
    );
    const activation = await measureWithEventLoopDelay(() => extension.activate());
    await vscode.workspace.getConfiguration('shellCompletion').update(
      'maxDocumentCharacters',
      0,
      vscode.ConfigurationTarget.Global,
    );
    const maximumDocumentCharacters = vscode.workspace
      .getConfiguration('shellCompletion')
      .get<number>('maxDocumentCharacters');
    const scanUnknownCommands = vscode.workspace
      .getConfiguration('shellCompletion')
      .get<boolean>('scanUnknownCommands');

    const scenarios: ScenarioReport[] = [activationScenario(activationProfile, activation)];
    if (suite === 'provider') {
      scenarios.push(await runCacheHitScenario(
        'completion',
        recordingEnabled,
        warmupSamples,
        samplesPerScenario,
      ));
      scenarios.push(await runCacheHitScenario(
        'hover',
        recordingEnabled,
        warmupSamples,
        samplesPerScenario,
      ));
      scenarios.push(await runCacheMissScenario(
        recordingEnabled,
        warmupSamples,
        samplesPerScenario,
      ));
      for (const characters of [10 * 1024, 100 * 1024, 1024 * 1024]) {
        scenarios.push(await runParseScenario(
          characters,
          recordingEnabled,
          warmupSamples,
          samplesPerScenario,
        ));
      }
    }

    const cpu = cpus()[0];
    const report = {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      process: {
        sequence: Number(process.env.VSCODE_H2O_PERFORMANCE_PROCESS_SEQUENCE),
        arm: process.env.VSCODE_H2O_PERFORMANCE_PROCESS_ARM,
        mode,
        suite,
        activationProfile,
      },
      source: {
        sha: process.env.VSCODE_H2O_PERFORMANCE_SOURCE_SHA || null,
        digestSha256: process.env.VSCODE_H2O_PERFORMANCE_SOURCE_DIGEST ?? null,
      },
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        vscode: vscode.version,
        node: process.versions.node,
        cpuModel: cpu?.model ?? null,
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      configuration: {
        maximumDocumentCharacters,
        scanUnknownCommands,
        providerFixture: 'deterministic-local-command-v2',
        activationFixture: preparedActivationFixture,
        eventLoopProbeIntervalMs,
      },
      sampling: {
        warmupSamples: suite === 'provider' ? warmupSamples : 0,
        samplesPerScenario: suite === 'provider' ? samplesPerScenario : 1,
        quantileMethod: 'linear-interpolation-rank-n-minus-1',
      },
      scenarios,
    };
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
