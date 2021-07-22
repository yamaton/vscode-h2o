# Shell Completion

This extension adds shell-completion-like autocomplete and introspection to the **Shell Script mode**.

* Command-line option/flag completion
* Subcommand completion
* Pop-up introspection for subcommands and options/flags
* Command name completion
* **No configuration needed**


## Demo: Autocomplete in Shell Script
![shellcomp](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-autocomplete.gif)



## Demo: Pop-up introspection

![hover](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-mouseover.gif)



## Preloaded data

This extension comes with some CLI data though it also can dynamically create autocompletion data from man and help pages in your local environment. The preprocessed data include:

* git
* npm
* docker
* terraform
* brew
* apt
* conda
* cargo
* go
* ... and many more!

[Here](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt) is the complete list. Please post [here](https://github.com/yamaton/h2o-curated-data/issues/1) if you want more tools added.

## Autocompletion data for bioinformatics tools

Autocompletion data for some bioinformatics tools is available. Type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Bioinformatics CLI Data` to load them all.

* BLAST
* GATK
* seqkit
* samtools
* Quast
* ... and many more!

[Here](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt) is the list of bioinformatics tools supported by the extra data. Please post [here](https://github.com/yamaton/h2o-curated-data/issues/1) if you find some missing.


## Extension Commands

This extension provides following commands:

* `Shell Completion: Clear Cache`: Clears cache for the specified command. May be invoked from `Reset` button on a hover window over a command.
* `Shell Completion: Load Common CLI Data`: Download curated CLI data from [here](https://github.com/yamaton/h2o-curated-data/tree/main/general/json), and force update the local cache.
* `Shell Completion: Load Bioinformatics CLI Data`: Download curated bioinformatics CLI data from [here](https://github.com/yamaton/h2o-curated-data/tree/main/bio/json), and force update the local cache.
* `Shell Completion: Remove Bioinformatics CLI Data`: Remove bioinformatics CLI info from the local cache.



## Extension Configuration

* `Shell Completion: Path`: Set path to H2O, a manpage/help parser used to extract CLI information. Leave it `<bundled>` to use the bundled executable.



## Security and Sandboxing

When this extension sees an unregistered command, it runs the command with options `--help`, `-help`, `help`, `-h` to get the command information. This may trigger harm in a bare environment if there are untrusted programs. To keep your system safe, this extension executes a command in a sandbox environment if available; i.e. a malicious program cannot access your network or filesystems in the sandbox.

* If you are on macOS, you're just fine; this extension uses the built-in program.
* If you are on **Linux or WSL** (Windows Subsystem for Linux), please install **[bubblewrap](https://wiki.archlinux.org/title/Bubblewrap)**. This extension uses it automatically if installed.


## Trouble Shooting

### Not working for some commands?

* If the command is in [this list](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt), type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Common CLI Data` to reload the preprocessed data.
* If the command is in [this (bio) list](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt), type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Bioinformatics CLI Data` to reload the preprocessed data.
* Otherwise, it's likely that H2O failed to parse the command info, and the junk data is in the way.  Type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS), choose `Shell Completion: Clear Cache`, and enter the name of the command to remove the data from the cache. Then H2O will try recreating the CLI data.



### Annoyed by unwanted programs?
To remove all autocomplete info, type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Remove Bioinformatics CLI Data`. You can also remove any CLI data one by one by invoking `Shell Completion: Clear Cache` command from `Ctrl`+`Shift`+`P` ( `⌘`+`⇧`+`P` ).


## How the extension works

* This extension uses [preprocessed data](https://github.com/yamaton/h2o-curated-data/tree/main/general/json) to show command data if available.
* Otherwise, this extension runs [H2O](https://github.com/yamaton/h2o) and extracts CLI information by parsing `man <command>`  or  `<command> --help`.
  * **[NOTE]** Bundled `h2o` runs on Linux/WSL and macOS only.
* This program depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script structure.


## Known Issues

* Autocomplete and mouse-over introspection work only if
  * The command is available in [the preprocessed CLI data](https://github.com/yamaton/h2o-curated-data/tree/main/general/json) loaded at the startup.
  * Or, H2O successfully extracts the CLI information from your local environment.

