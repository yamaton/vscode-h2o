import * as assert from 'assert';
import {
  ProviderMeasurement,
  ProviderPerformanceRecorder,
} from '../../providerPerformance';

suite('provider performance measurement', () => {
  test('accumulates phases and freezes total time when finished', async () => {
    const readings = [10, 12, 15, 20, 24, 30];
    const measurement = new ProviderMeasurement(() => readings.shift()!);

    assert.strictEqual(measurement.measure('analysisMs', () => 'value'), 'value');
    assert.strictEqual(await measurement.measureAsync('commandFetchMs', async () => 'command'), 'command');
    measurement.add('parseMs', 1.5);

    const timings = measurement.finish();
    assert.deepStrictEqual(timings, {
      totalMs: 20,
      treeWaitMs: 0,
      parseMs: 1.5,
      treeCopyMs: 0,
      analysisMs: 3,
      commandFetchMs: 4,
      pathResolveMs: 0,
      unclassifiedMs: 13,
    });
    assert.strictEqual(measurement.finish(), timings);
    measurement.add('analysisMs', 99);
    assert.strictEqual(timings.analysisMs, 3);
  });

  test('keeps only bounded non-document samples', () => {
    const recorder = new ProviderPerformanceRecorder(2);
    const timings = {
      totalMs: 1,
      treeWaitMs: 0,
      parseMs: 0,
      treeCopyMs: 0,
      analysisMs: 1,
      commandFetchMs: 0,
      pathResolveMs: 0,
      unclassifiedMs: 0,
    };

    recorder.record('completion', 'items', timings);
    recorder.record('hover', 'hover', timings);
    recorder.record('completion', 'suppressed', timings);

    assert.deepStrictEqual(
      recorder.snapshot().map(sample => [sample.sequence, sample.kind, sample.outcome]),
      [
        [2, 'hover', 'hover'],
        [3, 'completion', 'suppressed'],
      ],
    );
    recorder.clear();
    assert.deepStrictEqual(recorder.snapshot(), []);
  });

  test('rejects invalid buffer capacities', () => {
    assert.throws(() => new ProviderPerformanceRecorder(0), /positive integer/);
  });
});
