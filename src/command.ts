export interface Option {
  names: string[],
  argument: string,
  description: string,
}

export interface Command {
  name: string,
  description: string,
  options: Option[],
  subcommands?: Command[],
  inheritedOptions?: Option[],
  aliases?: string[],
}

