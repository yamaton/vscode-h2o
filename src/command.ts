export interface Option {
  names: string[],
  argument: string,
  description: string,
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PositionalArgument {
  name: string,
  description: string,
}

export interface Command {
  name: string,
  description: string,
  options: Option[],
  subcommands?: Command[],
  inheritedOptions?: Option[],
  aliases?: string[],
  tldr?: string,
  usage?: string,
  version?: string,
  positionalArguments?: PositionalArgument[],
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __meta__?: { [key: string]: JsonValue },
}
