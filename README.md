# Shell script command completion

This extension adds autocomplete and introspection of commands to the **Shell Script mode**.

* Command-line option/flag completion
* Subcommand completion
* Pop-up introspection for subcommands and options/flags
* **No configuration needed**

## Demo: Autocomplete in Shell Script

![shellcomp](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-autocomplete.gif)



## Demo: Pop-up introspection

![hover](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-mouseover.gif)



## Preloaded data

This extension comes with some CLI data though it also can dynamically create autocompletion data from man pages and `--help` document in your local environment. The preprocessed data include:

* git
* npm
* docker
* terraform
* kubectl
* brew
* apt
* conda
* cargo
* go
* ... and many more!

[Here](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt) is the complete list. Please post [here](https://github.com/yamaton/h2o-curated-data/issues/1) if you want more tools added.

## [Optional] Autocompletion for bioinformatics tools

Autocompletion data for some bioinformatics tools is available. Just type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Bioinformatics CLI Data` to load them all.

* BLAST
* GATK
* seqkit
* samtools
* csvtools
* ... and many more!

[Here](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt) is the list of bioinformatics tools supported by the extra data. Please post [here](https://github.com/yamaton/h2o-curated-data/issues/1) if you find some missing.


## Managing shell commands

"Shell Commands" Explorer in the Side Bar shows which command spces are installed. The extension can synthesize new ones on demand, though.

![](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-shell-command-explorer.png)



## Extension Commands

This extension provides following commands:

* `Shell Completion: Clear Cache`: Remove the specified command. `Reset` button on a hover window over a command also works in the same way.
* `Shell Completion: Load Common CLI Data`: Download curated CLI data from [here](https://github.com/yamaton/h2o-curated-data/tree/main/general/json), and force update the local cache.
* `Shell Completion: Load Bioinformatics CLI Data`: Download curated bioinformatics CLI data from [here](https://github.com/yamaton/h2o-curated-data/tree/main/bio/json), and force update the local cache.
* `Shell Completion: Remove Bioinformatics CLI Data`: Remove the bioinformatics package.
* `Shell Completion: Load Command... [experimental]`: Load individual command spec from [experimental directory](https://github.com/yamaton/h2o-curated-data/tree/main/experimental/json).



## Security with sandboxing

When this extension sees an unregistered command, it runs the command in the background with options `--help` to get the command information. This may trigger harm if you have untrusted programs locally. To keep your system safe, this extension executes a command in a sandbox environment if available; i.e. program cannot access your network or filesystems.

* In macOS, our program always runs in a sandbox using `sandbox-exec`.
* In **Linux or WSL** (Windows Subsystem for Linux), consider installing **[bubblewrap](https://wiki.archlinux.org/title/Bubblewrap)**. This extension uses it automatically if available.

## Trouble Shooting

### Not working for some commands?

* If the command is in [this list](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt), type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Common CLI Data` to reload the preprocessed data.
* If the command is in [this (bio) list](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt), type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Bioinformatics CLI Data` to reload the preprocessed data.
* Otherwise, it's likely that our program failed to extract the command information.  To retry the extraction process, type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Clear Cache`, and enter the name of the command to remove the data from the cache. Then our program will try recreating the CLI data when the command is typed.



### Annoyed by unwanted programs?
You can also remove any command individually by invoking `Shell Completion: Clear Cache` command after pressing `Ctrl`+`Shift`+`P` ( `⌘`+`⇧`+`P` ). To remove all bioinformatics commands, type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Remove Bioinformatics CLI Data`.



## How the extension works

* This extension uses [preprocessed data](https://github.com/yamaton/h2o-curated-data/tree/main/general/json) to show command data if available.
* Otherwise, this extension runs [H2O](https://github.com/yamaton/h2o) and extracts CLI information by parsing `man <command>`  or  `<command> --help`.
  * **[NOTE]** Bundled `h2o` runs on Linux/WSL and macOS only.
* This extension depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script structure.



## Known Issues

* Autocomplete and mouse-over introspection work only if
  * The command is available in [the preprocessed CLI data](https://github.com/yamaton/h2o-curated-data/tree/main/general/json) loaded at the startup.
  * Or, H2O successfully extracts the CLI information from your local environment.

