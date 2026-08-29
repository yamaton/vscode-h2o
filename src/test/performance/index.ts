import * as assert from 'assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';

import { CachingFetcher } from '../../cacheFetcher';
import type { Command } from '../../command';
import type {
  ProviderPerformanceKind,
  ProviderPerformanceSample,
  ProviderPhaseTimings,
} from '../../providerPerformance';

const extensionId = 'tetradresearch.vscode-h2o';
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

interface ScenarioObservation {
  externalTotalMs: number;
  provider: ProviderPerformanceSample | null;
}

interface ScenarioReport {
  name: string;
  kind: ProviderPerformanceKind;
  expectedOutcome: string;
  documentCharacters: number;
  observations: ScenarioObservation[];
  summary: {
    externalTotalMs: Distribution;
    provider: Record<keyof ProviderPhaseTimings, Distribution> | null;
  };
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

function fixtureCommand(): Command {
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

function sourceWithCharacters(characters: number): string {
  const suffix = '\ngit --';
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
  operation: () => Promise<number>,
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
  const externalTotals: number[] = [];
  for (let index = 0; index < samplesPerScenario; index += 1) {
    externalTotals.push(await operation());
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

  const observations = externalTotals.map((externalTotalMs, index) => ({
    externalTotalMs,
    provider: providerSamples[index] ?? null,
  }));
  return {
    name,
    kind,
    expectedOutcome,
    documentCharacters,
    observations,
    summary: {
      externalTotalMs: distribution(externalTotals),
      provider: recordingEnabled ? summarizeProvider(providerSamples) : null,
    },
  };
}

async function executeCompletion(document: vscode.TextDocument): Promise<number> {
  const startedAt = performance.now();
  const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    document.positionAt(document.getText().length),
  );
  const elapsed = performance.now() - startedAt;
  assert.ok(completion.items.some(item => {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    return label === '--version';
  }));
  return elapsed;
}

async function executeHover(document: vscode.TextDocument): Promise<number> {
  const commandOffset = document.getText().lastIndexOf('git');
  const startedAt = performance.now();
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    document.uri,
    document.positionAt(commandOffset + 1),
  );
  const elapsed = performance.now() - startedAt;
  assert.ok(hovers.length > 0);
  return elapsed;
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

export async function run(): Promise<void> {
  const reportPath = process.env.VSCODE_H2O_PERFORMANCE_REPORT;
  assert.ok(reportPath, 'VSCODE_H2O_PERFORMANCE_REPORT is required');
  const mode = process.env.VSCODE_H2O_PERFORMANCE_MODE;
  assert.ok(mode === 'instrumented' || mode === 'production', 'performance mode is required');
  const recordingEnabled = mode === 'instrumented';
  assert.strictEqual(process.env.VSCODE_H2O_PERFORMANCE === '1', recordingEnabled);
  const warmupSamples = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_WARMUP_SAMPLES', 5);
  const samplesPerScenario = positiveIntegerEnvironment('VSCODE_H2O_PERFORMANCE_SAMPLES', 30);

  const originalStartInitialCuratedFetch = CachingFetcher.prototype.startInitialCuratedFetch;
  CachingFetcher.prototype.startInitialCuratedFetch = function startInitialCuratedFetch(): Promise<void> {
    const internals = this as unknown as { commands: Map<string, Command> };
    internals.commands.set('git', fixtureCommand());
    return Promise.resolve();
  };

  try {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `${extensionId} must be installed in the Extension Host`);
    await extension.activate();
    await vscode.workspace.getConfiguration('shellCompletion').update(
      'maxDocumentCharacters',
      0,
      vscode.ConfigurationTarget.Global,
    );
    const maximumDocumentCharacters = vscode.workspace
      .getConfiguration('shellCompletion')
      .get<number>('maxDocumentCharacters');

    const scenarios: ScenarioReport[] = [];
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
    for (const characters of [10 * 1024, 100 * 1024, 1024 * 1024]) {
      scenarios.push(await runParseScenario(
        characters,
        recordingEnabled,
        warmupSamples,
        samplesPerScenario,
      ));
    }

    const cpu = cpus()[0];
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      process: {
        sequence: Number(process.env.VSCODE_H2O_PERFORMANCE_PROCESS_SEQUENCE),
        arm: process.env.VSCODE_H2O_PERFORMANCE_PROCESS_ARM,
        mode,
      },
      sourceDigestSha256: process.env.VSCODE_H2O_PERFORMANCE_SOURCE_DIGEST ?? null,
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
        fixture: 'deterministic-local-git-v1',
      },
      sampling: {
        warmupSamples,
        samplesPerScenario,
        quantileMethod: 'linear-interpolation-rank-n-minus-1',
      },
      scenarios,
    };
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } finally {
    CachingFetcher.prototype.startInitialCuratedFetch = originalStartInitialCuratedFetch;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
