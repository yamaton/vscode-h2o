# CLI Completion -- H2O for VS Code

This extension enables completion, auto-completing subcommands and options, for CLI programs in Shell Script. It uses [H2O](https://github.com/yamaton/h2o) as the backend; H2O extracts CLI information by executing and parsing `<command> --help` or manpages (and `<command> <subcommand> --help` if needed).


**[NOTE]** `h2o` executable is bundled, but it's for Linux/WSL and MacOS (x86-64) only.


## Shell completion demo
![shellcomp](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-h2o-completion.gif)

## Hover demo
![hover](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-h2o-hover.gif)


## Sandbox for Linux Users
Please consider installing [bubblewrap](https://wiki.archlinux.org/title/Bubblewrap) if using the extension on Linux or WSL. H2O runs commands in the sandbox, if available, such that untrusted commands do no harm.


## Extension Commands

This extension provides following commands:

* `Shell Completion: Reset`: Clears cache for the specified command. May be invoked from a hover window over a command.
* `Shell Completion: Download and Force Update Local CLI Data`: Download curated data from [here](https://github.com/yamaton/h2o-curated-data/tree/main/json), and force update local CLI info.


## Extension Configuration

* `Shell Completion: Path`: Set path to H2O. Enter `<bundled>` to use the bundled.

## Internals

This program depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script.


## Known Issues

* Command hovers and completions work only if
    * The command is available in [the preprocessed CLI data](https://github.com/yamaton/h2o-curated-data/tree/main/json), which is loaded automatically if not already created locally.
    * Or, H2O successfully extracts the CLI information from your local environment.
