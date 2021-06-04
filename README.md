# H2O for VS Code

This extension integrates [H2O](https://github.com/yamaton/h2o) into VS Code.

**[NOTE]** `h2o` executable is bundled, but it's for Linux (x86-64) only right now.


## Features

It provides completions for command options and subcommands in shell script. H2O extracts CLI information in the background by running and parsing `<command> --help` (and `<command> <subcommand> --help` if needed).


## Extension Commands

This extension provides following commands:

* `H2O: Reset`: Clears cache for the specified command.


## Internals

This program depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script as bash.


## Known Issues

* Shows completions and information only if
    * The command is available in the system.
    * H2O successfully parses the help document.
