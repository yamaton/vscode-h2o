# H2O for VS Code

This extension integrates [H2O](https://github.com/yamaton/h2o) into VS Code.

**[NOTE]** `h2o` executable is bundled, but it's for Linux and MacOS (x86-64) only.


## About

It provides completions and hovers for command options and subcommands in shell script. H2O, in the background, extracts CLI information by executing and parsing `<command> --help` or manpages (and `<command> <subcommand> --help` if needed).

## Shell completion
![shellcomp](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-h2o-completion.gif)

## Hover
![hover](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-h2o-hover.gif)


## Extension Commands

This extension provides following commands:

* `H2O: Reset`: Clears cache for the specified command.

The is also accessible from the hover on a command.


## Extension Configuration

* `H2o: Path`: Set path to H2O. Enter `<bundled>`, the default value, if using bundled.


## Sandbox for Linux Users
Please install [bubblewrap](https://wiki.archlinux.org/title/Bubblewrap) if using this extension in Linux or WSL. H2O automatically runs in the sandbox if available such that untrusted commands do no harm.


## Internals

This program depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script as bash.


## Known Issues

* H2O shows completions and hovers only if
    * The command is available in the system.
    * H2O successfully extracts the information from help/man.
