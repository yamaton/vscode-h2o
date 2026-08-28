import { once } from 'events';
import { createGzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { Command, Option, PositionalArgument } from './command';

const gunzipAsync = promisify(gunzip);
const streamingGzipLevel = 1;
const commandsPerYield = 8;
const validatedCommandArrays = new WeakSet<object>();

export const commandCacheSnapshotVersion = 1;

export interface CommandCacheSnapshot {
  version: typeof commandCacheSnapshotVersion;
  commands: Command[];
}

export interface CommandCacheStorage {
  load(): Promise<CommandCacheSnapshot | undefined>;
  save(snapshot: CommandCacheSnapshot): Promise<void>;
}

export interface CacheFileSystem<TUri> {
  createDirectory(uri: TUri): PromiseLike<void>;
  delete(uri: TUri): PromiseLike<void>;
  readFile(uri: TUri): PromiseLike<Uint8Array>;
  writeFile(uri: TUri, content: Uint8Array): PromiseLike<void>;
  rename(source: TUri, target: TUri, options: { overwrite: boolean }): PromiseLike<void>;
}

export interface CacheStorageUris<TUri> {
  directory: TUri;
  snapshot: TUri;
  temporary(): TUri;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOption(value: unknown): value is Option {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.names)
    && value.names.every(name => typeof name === 'string')
    && typeof value.argument === 'string'
    && typeof value.description === 'string';
}

function isPositionalArgument(value: unknown): value is PositionalArgument {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function isOptionalOptionArray(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every(isOption));
}

function isOptionalPositionalArgumentArray(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every(isPositionalArgument));
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isCommand(value: unknown, ancestors = new WeakSet<object>()): value is Command {
  if (!isRecord(value) || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.description === 'string'
    && Array.isArray(value.options)
    && value.options.every(isOption)
    && (value.subcommands === undefined
      || (Array.isArray(value.subcommands) && value.subcommands.every(command => isCommand(command, ancestors))))
    && isOptionalOptionArray(value.inheritedOptions)
    && isOptionalStringArray(value.aliases)
    && isOptionalString(value.tldr)
    && isOptionalString(value.usage)
    && isOptionalString(value.version)
    && isOptionalPositionalArgumentArray(value.positionalArguments)
    && isOptionalRecord(value.__meta__);
  ancestors.delete(value);
  return valid;
}

function validateAndDeepFreeze(
  value: unknown,
  ancestors = new WeakSet<object>(),
  frozen = new WeakSet<object>(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Command cache contains a non-finite number.');
    }
    return;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error('Command cache contains a non-JSON-compatible value.');
  }

  if (frozen.has(value)) {
    return;
  }
  if (ancestors.has(value)) {
    throw new Error('Command cache contains a cyclic value.');
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Command cache contains a non-JSON-compatible object.');
    }
  }

  ancestors.add(value);
  const array = Array.isArray(value);
  let arrayIndex = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string'
      || !descriptor
      || !descriptor.enumerable
      || !('value' in descriptor)
      || (array && key !== String(arrayIndex))) {
      throw new Error('Command cache contains a non-JSON-compatible property.');
    }
    validateAndDeepFreeze(descriptor.value, ancestors, frozen);
    arrayIndex += 1;
  }
  if (array && arrayIndex !== value.length) {
    throw new Error('Command cache contains a sparse array.');
  }
  ancestors.delete(value);
  frozen.add(value);
  Object.freeze(value);
}

function validateAndDeepFreezeParsed(
  value: unknown,
  ancestors = new WeakSet<object>(),
  frozen = new WeakSet<object>(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Command cache contains a non-finite number.');
    }
    return;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error('Command cache contains a non-JSON-compatible value.');
  }

  if (frozen.has(value)) {
    return;
  }
  if (ancestors.has(value)) {
    throw new Error('Command cache contains a cyclic value.');
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Command cache contains a non-JSON-compatible object.');
    }
  }

  // JSON.parse creates dense arrays and enumerable data properties only.
  // Its output can therefore avoid descriptor checks without weakening the
  // accepted serialized format.
  ancestors.add(value);
  for (const child of Object.values(value)) {
    validateAndDeepFreezeParsed(child, ancestors, frozen);
  }
  ancestors.delete(value);
  frozen.add(value);
  Object.freeze(value);
}

export function freezeCommand(command: Command): Command {
  validateAndDeepFreeze(command);
  return command;
}

function freezeParsedCommand(command: Command): Command {
  validateAndDeepFreezeParsed(command);
  return command;
}

function validateCommandShapes(value: unknown): Command[] {
  if (!Array.isArray(value)) {
    throw new Error('Command cache must contain an array of commands.');
  }

  const names = new Set<string>();
  for (const command of value) {
    if (!isCommand(command)) {
      throw new Error('Command cache contains an invalid command.');
    }
    if (names.has(command.name)) {
      throw new Error(`Command cache contains duplicate command: ${command.name}`);
    }
    names.add(command.name);
  }
  return value;
}

export function validateCommands(value: unknown): Command[] {
  if (typeof value === 'object' && value !== null && validatedCommandArrays.has(value)) {
    return value as Command[];
  }
  const commands = validateCommandShapes(value);
  for (const command of commands) {
    freezeCommand(command);
  }
  Object.freeze(commands);
  validatedCommandArrays.add(commands);
  return commands;
}

export async function validateCommandsYielding(value: unknown): Promise<Command[]> {
  return validateCommandsYieldingInternal(value, true);
}

async function validateParsedCommandsYielding(value: unknown): Promise<Command[]> {
  return validateCommandsYieldingInternal(value, false);
}

async function validateCommandsYieldingInternal(
  value: unknown,
  inspectPropertyDescriptors: boolean,
): Promise<Command[]> {
  if (typeof value === 'object' && value !== null && validatedCommandArrays.has(value)) {
    return value as Command[];
  }
  if (!Array.isArray(value)) {
    throw new Error('Command cache must contain an array of commands.');
  }

  const names = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const command = value[index];
    if (!isCommand(command)) {
      throw new Error('Command cache contains an invalid command.');
    }
    if (names.has(command.name)) {
      throw new Error(`Command cache contains duplicate command: ${command.name}`);
    }
    names.add(command.name);
    if ((index + 1) % commandsPerYield === 0) {
      await yieldToEventLoop();
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (inspectPropertyDescriptors) {
      freezeCommand(value[index]);
    } else {
      freezeParsedCommand(value[index]);
    }
    if ((index + 1) % commandsPerYield === 0) {
      await yieldToEventLoop();
    }
  }
  Object.freeze(value);
  validatedCommandArrays.add(value);
  return value;
}

export async function decodeCommandBundle(content: Uint8Array): Promise<Command[]> {
  const decoded = await gunzipAsync(Buffer.from(content));
  const json = decoded.toString('utf8');
  await yieldToEventLoop();
  const parsed = JSON.parse(json) as unknown;
  await yieldToEventLoop();
  return validateParsedCommandsYielding(parsed);
}

export async function encodeCommandCacheSnapshot(snapshot: CommandCacheSnapshot): Promise<Buffer> {
  const compressor = createGzip({ level: streamingGzipLevel });
  const chunks: Buffer[] = [];
  compressor.on('data', (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<void>((resolve, reject) => {
    compressor.once('end', resolve);
    compressor.once('error', reject);
  });
  void completed.catch(() => undefined);

  try {
    await writeCompressed(compressor, `{"version":${snapshot.version},"commands":[`);
    for (let index = 0; index < snapshot.commands.length; index += 1) {
      const prefix = index === 0 ? '' : ',';
      await writeCompressed(compressor, prefix + JSON.stringify(snapshot.commands[index]));
      if ((index + 1) % commandsPerYield === 0) {
        await yieldToEventLoop();
      }
    }
    compressor.end(']}');
    await completed;
    return Buffer.concat(chunks);
  } catch (error) {
    compressor.destroy();
    throw error;
  }
}

export async function decodeCommandCacheSnapshot(content: Uint8Array): Promise<CommandCacheSnapshot> {
  const decoded = await gunzipAsync(Buffer.from(content));
  const json = decoded.toString('utf8');
  await yieldToEventLoop();
  const parsed = JSON.parse(json) as unknown;
  await yieldToEventLoop();
  if (!isRecord(parsed) || parsed.version !== commandCacheSnapshotVersion) {
    throw new Error('Command cache has an unsupported schema version.');
  }
  return {
    version: commandCacheSnapshotVersion,
    commands: await validateParsedCommandsYielding(parsed.commands),
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function writeCompressed(compressor: ReturnType<typeof createGzip>, content: string): Promise<void> {
  if (!compressor.write(content)) {
    await once(compressor, 'drain');
  }
}

export class InvalidCommandCacheSnapshotError extends Error {
  constructor(public readonly originalError: unknown) {
    super('The command cache snapshot is invalid.');
    this.name = 'InvalidCommandCacheSnapshotError';
  }
}

function isFileNotFound(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.code === 'FileNotFound'
    || error.code === 'ENOENT'
    || error.name === 'FileNotFound'
    || error.name === 'EntryNotFound'
    || error.name === 'FileNotFound (FileSystemError)'
    || error.name === 'EntryNotFound (FileSystemError)';
}

export class GzipCommandCacheStorage<TUri> implements CommandCacheStorage {
  constructor(
    private readonly fileSystem: CacheFileSystem<TUri>,
    private readonly uris: CacheStorageUris<TUri>,
  ) {}

  public async load(): Promise<CommandCacheSnapshot | undefined> {
    let content: Uint8Array;
    try {
      content = await this.fileSystem.readFile(this.uris.snapshot);
    } catch (error) {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    try {
      return await decodeCommandCacheSnapshot(content);
    } catch (error) {
      throw new InvalidCommandCacheSnapshotError(error);
    }
  }

  public async save(snapshot: CommandCacheSnapshot): Promise<void> {
    const content = await encodeCommandCacheSnapshot(snapshot);
    const temporary = this.uris.temporary();
    await this.fileSystem.createDirectory(this.uris.directory);
    try {
      await this.fileSystem.writeFile(temporary, content);
      await this.fileSystem.rename(temporary, this.uris.snapshot, { overwrite: true });
    } catch (error) {
      try {
        await this.fileSystem.delete(temporary);
      } catch (cleanupError) {
        if (!isFileNotFound(cleanupError)) {
          console.warn('[CommandCacheStorage.save] Failed to delete temporary snapshot:', cleanupError);
        }
      }
      throw error;
    }
  }
}
