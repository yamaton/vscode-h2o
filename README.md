# Shell script command completion

This extension adds autocompletion and introspection of commands to the **Shell Script mode**.

* Command-line option/flag/subcommand completion
* Hover introspection for subcommands and options/flags
* **Zero configuration**


## Demo: Autocomplete in shell script

![shellcomp](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-autocomplete.gif)



## Demo: Introspect with hover

![hover](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-mouseover.gif)



## Supported commands

This extension comes with some CLI specs though it can dynamically create specs by scanning man pages or `--help` documents in your local environment. The preloaded specs include:

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
* ...

[Here](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt) is the complete list of preloaded specs. Please post [here](https://github.com/yamaton/h2o-curated-data/issues/1) if you want more tools added.

## [Optional] Extra command specs for bioinformatics

Command specs for some bioinformatics tools are available optionally. Just type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Bioinformatics CLI Data` to load them all.

* BLAST
* GATK
* seqkit
* samtools
* csvtools
* ...

[Here](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt) is the list of bioinformatics tools supported by the extra data. Please post [here](https://github.com/yamaton/h2o-curated-data/issues/1) if you find some missing.


## Managing command specs

"Shell Commands" Explorer in the Side Bar shows which command specs are loaded.

![](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-shell-command-explorer.png)



## 🔥 Trouble Shooting

### Not working?

* If the command is in [this list](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt), type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Common CLI Data` to reload the preprocessed data.
* If the command is in [this (bio) list](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt), type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Load Bioinformatics CLI Data` to reload the preprocessed data.
* Otherwise, it's likely that our program failed to extract the command spec from your system.  To retry the extraction process, type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Clear Cache`, and enter the name of the command to remove the data from the cache. Then our program will try recreating the CLI data when the command is typed.


### Annoyed by aggressive suggestions?

We can adjust suggestions with the VS Code settings.

* Editor: **Quick Suggestions** can suppress suggestions while typing.
* Editor: **Suggest on Trigger Characters** can deactivate SPACE-key triggering.

Note: The setting applies to other language modes as well.


### Annoyed by unwanted commands?

Shell Commands Explorer in the Side Bar is the best interface to remove unnecessary command specs.

To remove all bioinformatics commands, type `Ctrl`+`Shift`+`P` (or `⌘`+`⇧`+`P` on macOS) and choose `Shell Completion: Remove Bioinformatics CLI Data`.


## 🔧 How the extension works

* This extension uses [preprocessed data](https://github.com/yamaton/h2o-curated-data/tree/main/general/json) to show command info if available.
* Otherwise, this extension runs [H2O](https://github.com/yamaton/h2o) and extracts CLI information by parsing `man <command>`  or  `<command> --help`.
  * **[NOTE]** Bundled `h2o` runs on Linux/WSL and macOS only.
* This extension depends on [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to understand shell script structure.



## 🛡️ Security with sandboxing

When this extension sees an unregistered command, it runs the command in the background with options `--help` to get the command information. This may trigger harm if you have untrusted programs locally. To keep your system safe, this extension executes a command in a sandbox environment if available; i.e. program cannot access your network or filesystems.

* In macOS, our program always runs in a sandbox using `sandbox-exec`.
* In **Linux or WSL** (Windows Subsystem for Linux), consider installing **[bubblewrap](https://wiki.archlinux.org/title/Bubblewrap)**. This extension uses it automatically if available.


## ⚠️ Known Issues

* Autocomplete and mouse-over introspection work only if
  * The command is available in [the preprocessed CLI data](https://github.com/yamaton/h2o-curated-data/tree/main/general/json) loaded at the startup.
  * Or, H2O successfully extracts the CLI information from your local environment.
* Extra hyphens remain when completing a command option.
  * Will fix by the end of April 2022. Please refer [this issue](https://github.com/yamaton/h2o-curated-data/issues/2).
