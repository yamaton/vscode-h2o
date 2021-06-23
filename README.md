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

* `Shell Completion: Clear Cache`: Clears cache for the specified command. May be invoked from `Reset` button on a hover window over a command.
* `Shell Completion: Load General-Purpose CLI Data`: Download curated general-purpose CLI data from [here](https://github.com/yamaton/h2o-curated-data/tree/main/general/json), and force update the local cache.
* `Shell Completion: Load Bioinformatics CLI Data`: Download curated bioinformatics CLI data from [here](https://github.com/yamaton/h2o-curated-data/tree/main/bio/json), and force update the local cache.
* `Shell Completion: Remove Bioinformatics CLI Data`: Remove bioinformatics CLI info from the local cache.


## Extension Configuration

* `Shell Completion: Path`: Set path to H2O. Enter `<bundled>` to use the bundled.



## Trouble Shooting

#### Not showing command-name completion for certain commands?
This glitch occurs due to the transition to v0.0.11 and later. We may be able to solve this by reloading the command:

1. Type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS), choose `Shell Completion: Clear Cache`, and specify the name to remove the command from the cache.
2. Type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) again and choose `Shell Completion: Load General-Purpose CLI Data` or `Shell Completion: Load Bioinformatics CLI Data`.


#### Annoyed by completions of unwanted program names?
To remove the bioinformatics CLI info, type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Remove Bioinformatics CLI Data`. You can also remove the CLI information one by one by invoking `Shell Completion: Clear Cache` command.


#### Need bioinformatics tools?
[Here](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt) is the list of currently preprocessed CLI data for bioinformatics tools. Type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Bioinformatics CLI Data` to load them. Please post [here](https://github.com/yamaton/h2o-curated-data/issues/1) if you feel some tools missing.



## Internals

This program depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script.


## Known Issues

* Command hovers and completions work only if
    * The command is available in [the preprocessed general-purpose CLI data](https://github.com/yamaton/h2o-curated-data/tree/main/general/json), which is loaded automatically if not already created locally.
        * Optionally, one can load [preprocessed bioinformatics CLI data](https://github.com/yamaton/h2o-curated-data/tree/main/bio/json) with the command.
    * Or, H2O successfully extracts the CLI information from your local environment.
