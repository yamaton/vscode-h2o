import * as assert from 'assert';
import { formatDescription, formatTldr, formatUsage, getLabelString, isPrefixOf } from '../../utils';

suite('formatting utilities', () => {
  test('formats TLDR markup for hover text', () => {
    const input = '# title\n> Example\n`git {{path/to/file}}`';
    const output = formatTldr(input);

    assert.ok(!output.includes('# title'));
    assert.ok(output.includes('Example'));
    assert.ok(output.includes('git path/to/file'));
  });

  test('formats usage and description text', () => {
    assert.strictEqual(formatUsage(undefined), '');
    assert.ok(formatUsage('git status\ngit log').includes('     git log'));
    assert.strictEqual(formatDescription('  details  '), '\n\ndetails');
  });

  test('checks prefixes and completion item labels', () => {
    assert.strictEqual(isPrefixOf('gi', 'git'), true);
    assert.strictEqual(isPrefixOf('github', 'git'), false);
    assert.strictEqual(getLabelString('git'), 'git');
    assert.strictEqual(getLabelString({ label: 'npm', description: 'package manager' }), 'npm');
  });
});
