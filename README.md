# CLI Completion -- H2O for VS Code

This extension enables completion, auto-completing subcommands and options, for CLI programs in Shell Script. It uses [H2O](https://github.com/yamaton/h2o) as the backend; H2O extracts CLI information by executing and parsing `<command> --help` or manpages (and `<command> <subcommand> --help` if needed).


**[NOTE]** `h2o` executable is bundled, but it's for Linux/WSL and MacOS (x86-64) only.


## Shell completion demo
![shellcomp](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-h2o-completion.gif)

## Hover demo
![hover](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-h2o-hover.gif)


## Sandbox for Linux Users
Please consider installomg [bubblewrap](https://wiki.archlinux.org/title/Bubblewrap) if using in Linux or WSL. H2O automatically runs in the sandbox if available such that untrusted commands do no harm.


## Extension Commands

This extension provides following commands:

* `H2O: Reset`: Clears cache for the specified command.

This command can be also invoked by clicking 'Reset' in a hover window.


## Extension Configuration

* `H2o: Path`: Set path to H2O. Enter `<bundled>` to use the bundled.

## Internals

This program depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script.


## Known Issues

* Command hovers and completions work only if
    * The CLI data is preloaded
    * Or, H2O successfully extracts the CLI information from your local environment.
