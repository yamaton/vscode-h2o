import { Command } from './command';

export interface CommandSourceWord {
  text: string;
}

export interface CommandPathStep<TSource extends CommandSourceWord = CommandSourceWord> {
  command: Command;
  source: TSource;
  matchedBy: 'canonical' | 'alias';
}

export interface CommandPathResolution<TSource extends CommandSourceWord = CommandSourceWord> {
  path: Command[];
  steps: CommandPathStep<TSource>[];
  stopReason?: 'unresolved-word' | 'end-of-options';
}

export interface DirectSubcommandMatch {
  command: Command;
  matchedBy: 'canonical' | 'alias';
}

function findUniqueDirectSubcommand(command: Command, token: string): DirectSubcommandMatch | undefined {
  const subcommands = command.subcommands ?? [];
  const canonicalMatches = subcommands.filter(subcommand => subcommand.name === token);
  if (canonicalMatches.length === 1) {
    return { command: canonicalMatches[0], matchedBy: 'canonical' };
  }
  if (canonicalMatches.length > 1) {
    return undefined;
  }

  const aliasMatches = subcommands.filter(subcommand => subcommand.aliases?.includes(token));
  return aliasMatches.length === 1
    ? { command: aliasMatches[0], matchedBy: 'alias' }
    : undefined;
}

export interface DirectSubcommandLabel extends DirectSubcommandMatch {
  spelling: string;
}

/** Returns only spellings that the resolver can map to one direct child. */
export function getDirectSubcommandLabels(command: Command): DirectSubcommandLabel[] {
  const subcommands = command.subcommands ?? [];
  const spellings = new Set([
    ...subcommands.map(subcommand => subcommand.name),
    ...subcommands.flatMap(subcommand => subcommand.aliases ?? []),
  ]);

  return [...spellings].flatMap(spelling => {
    const match = findUniqueDirectSubcommand(command, spelling);
    return match ? [{ ...match, spelling }] : [];
  });
}

/**
 * Resolves direct subcommands by consuming source words once, from left to
 * right. Option-looking words do not change the current command. Any other
 * unmatched or ambiguous word closes the path.
 */
export function resolveCommandPath<TSource extends CommandSourceWord>(
  root: Command,
  args: readonly TSource[],
): CommandPathResolution<TSource> {
  const path = [root];
  const steps: CommandPathStep<TSource>[] = [];
  let stopReason: CommandPathResolution<TSource>['stopReason'];

  for (const source of args) {
    if (source.text === '--') {
      stopReason = 'end-of-options';
      break;
    }
    if (source.text.startsWith('-') && source.text !== '-') {
      continue;
    }

    const current = path[path.length - 1];
    const match = findUniqueDirectSubcommand(current, source.text);
    if (!match) {
      stopReason = 'unresolved-word';
      break;
    }

    path.push(match.command);
    steps.push({ ...match, source });
  }

  return { path, steps, stopReason };
}
