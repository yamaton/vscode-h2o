# Shell Script Command Completion

Write shell commands in VS Code with completions for commands, subcommands, options, and flags. Hover over them to see descriptions, usage, and examples without leaving the editor.

* Works with Shell Script files with no configuration required
* Loads specifications for 400+ common CLI tools automatically
* Learns from the `--help` output of other commands installed on your machine
* Offers an optional collection of 600+ bioinformatics CLI specifications
* Includes experimental BitBake support when a BitBake language mode is installed

![Command completion in a shell script](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-autocomplete.gif)

## Get Started

1. Install [Shell Script Command Completion](https://marketplace.visualstudio.com/items?itemName=tetradresearch.vscode-h2o).
2. Open a shell script and make sure its VS Code language mode is **Shell Script**.
3. Type a command followed by a space to complete its subcommands and options, or hover over an existing command to read its help.

Common command specifications are downloaded automatically and cached by the extension. The first download requires an internet connection.

The bundled help scanner supports Linux/WSL and macOS. See [Supported Platforms](#supported-platforms) for the exact combinations and current exclusions.

## Command Coverage

The common collection currently contains more than 400 command specifications, including `git`, `npm`, `docker`, and `terraform`. See [general.txt](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt) for the complete list.

When an installed command is not in the cache, the extension can create a specification from its `--help` output and save it for later use. The bundled scanner does not consult man pages.

Set `shellCompletion.scanUnknownCommands` to `false` to prevent these local help scans. Downloaded and previously cached specifications remain available. The setting applies to the machine running the VS Code Extension Host, including an individual remote environment, and a workspace cannot override it.

To request another curated command specification, [open a request in h2o-curated-data](https://github.com/yamaton/h2o-curated-data/issues/1).

### Bioinformatics Commands

The optional bioinformatics collection contains more than 600 specifications, including `BLAST`, `GATK`, `seqkit`, and `samtools`. See [bio.txt](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt) for the complete list.

With a Shell Script or BitBake editor active, open the Command Palette and run **Shell Completion: Load All Bioinformatics CLI Specs**. The collection can be removed again with **Shell Completion: Remove All Bioinformatics CLI Specs**.

## Inline Help

Hover over a recognized command, subcommand, option, or flag to see its description. Command hovers can also include usage and TLDR examples, while subcommand hovers can include usage when the specification provides it.

![Command documentation on hover](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/demo-mouseover.gif)

## Manage Command Specifications

The **Shell Commands** view in the Explorer lists the specifications currently stored in the extension cache. Use its refresh button to refresh the displayed list or the trash button to remove an entry.

![Shell Commands view in the Explorer](https://raw.githubusercontent.com/yamaton/vscode-h2o/main/images/vscode-shell-command-explorer.png)

The following commands are available from the Command Palette while a Shell Script or BitBake editor is active:

| Command | Purpose |
| --- | --- |
| **Shell Completion: Load All Common CLI Specs** | Download the common collection and replace cached entries with its current versions. |
| **Shell Completion: Load All Bioinformatics CLI Specs** | Download or update the optional bioinformatics collection. |
| **Shell Completion: Remove All Bioinformatics CLI Specs** | Remove the bioinformatics collection from the cache. |
| **Shell Completion: Load Command Spec (experimental)** | Download one specification from the experimental collection. |
| **Shell Completion: Remove Command Spec** | Remove one cached specification by name. |
| **Shell Completion: Inspect Caret Context** | Show parser and provider metadata for the active caret in the **Shell Completion Debug** output channel. |
| **Shell Completion: Toggle Live Caret and Cursor Context** | Toggle the live Completion, Hover, and Tree-sitter debug views. |
| **Shell Completion: Show Live Debug Views** | Open the **H2O Debug** panel, enabling live inspection if necessary. |

Loading, updating, or bulk-removing a collection requires an internet connection because the extension fetches its current bundle or command index.

### Inspect Caret Context

For completion debugging, or to inspect how hover would resolve at the insertion point, place the caret at the position to inspect and run **Shell Completion: Inspect Caret Context**. The command writes a JSON report to the **Shell Completion Debug** output channel and also returns that report to programmatic command callers. It includes:

* the tree-sitter node and ancestor chain, including grammar types, field names, ranges, error and missing-node flags, and parse states;
* the completion walkback position and redirect or error-recovery suppression reasons;
* the command invocation, resolved subcommand path, aliases, and resolver stop reason used by completion and hover; and
* the same observations from the incrementally cached tree and a fresh parse, with equivalence results for quick comparison.

The inspection follows the normal provider lookup path, so inspecting a command may populate its regenerable command-specification cache when unknown-command scanning is enabled.

For a compact view that follows caret movement, document edits, and hover requests, run **Shell Completion: Show Live Debug Views**. The **H2O Debug** panel separates the live information into three views:

* **Completion** follows the editor caret and shows the provider decision, requested-to-resolved walkback, command path, resolver stop reason, and the item count returned by the latest actual completion request.
* **Hover** follows the latest position VS Code delivered to the hover provider and shows the independent provider decision and whether an actual hover was returned. VS Code does not expose raw mouse-move events to extensions, so this view waits for the first hover request rather than pretending that the pointer is continuously observable.
* **Tree-sitter** shows the current nodes and expandable ancestor chains for the caret and the latest hover cursor. Grammar type, field name, range, text, and exceptional flags are kept here instead of being mixed into the provider summaries.

While live inspection is enabled, a single status bar item shows only the high-level state, for example `H2O C✓ H— TS:word`. `C` is completion, `H` is hover, and `TS` is the tree-sitter node at the caret. Click it to reveal the debug views. The view toolbar can pause and resume updates. Each view also has an **Open Debug Snapshot** action that opens its full current data as a read-only virtual JSON document for searching and copying; live JSON is no longer streamed through an Output channel. Run **Shell Completion: Toggle Live Caret and Cursor Context** to disable or re-enable the interface.

The H2O executable can also be selected with the `shellCompletion.h2oPath` setting. Its default value, `<bundled>`, uses the scanner packaged for the current platform. Like the unknown-command scan policy, this is a machine setting and is configured separately for a remote Extension Host.

Parser-backed completion, hover, and debug features are enabled by default for Shell Script and BitBake documents up to 1,048,576 UTF-16 characters. Use `shellCompletion.maxDocumentCharacters` to change this per workspace or workspace folder; set it to `0` to remove the limit.

## Supported Platforms

The Visual Studio Marketplace selects a package containing the native H2O scanner for the Extension Host that runs VS Code:

| Extension Host | Architecture | Support |
| --- | --- | --- |
| Linux, including glibc-based distributions and Alpine | x64 | Supported |
| Linux on glibc-based distributions | arm64 | Supported |
| macOS | x64, arm64 | Supported |
| Alpine | arm64 | Not currently supported |
| Windows | x64, arm64 | Not currently supported |

Remote environments such as WSL use the platform of their VS Code Extension Host. VS Code 1.101 or later is required.

## How It Works

* [tree-sitter](https://tree-sitter.github.io/tree-sitter/) identifies the command, subcommand, and option at the provider's requested position.
* The extension first looks for a command specification in its in-memory cache, restored from a compressed snapshot in VS Code global storage. This on-disk cache is regenerable and is not synchronized through Settings Sync.
* The common curated collection is downloaded in the background when the extension activates. Existing cached entries are preserved unless you explicitly reload the collection.
* When `shellCompletion.scanUnknownCommands` is enabled, an unknown command available in the local environment is passed to the bundled [H2O](https://github.com/yamaton/h2o) scanner, which runs `<command> --help`, parses the output, and caches the result.
* Network requests and local help scans have a 10-second timeout.

When upgrading from a version that stored command specifications in VS Code global state, the extension discards those legacy cache entries instead of migrating them. It then rebuilds the cache from curated data or locally scanned help output.

## Security

Creating a specification for an unknown command executes that command with `--help`. A program found in an untrusted local environment could therefore present a risk.

To prevent the extension from executing commands that are absent from its specification cache, set `shellCompletion.scanUnknownCommands` to `false` in user settings, or in remote settings when using a remote Extension Host. Changing the setting stops queued help scans and terminates a running scan; it does not delete downloaded or previously cached specifications.

The extension uses an operating-system sandbox when one is available:

* **macOS:** Uses `sandbox-exec` to deny filesystem writes and network access.
* **Linux and WSL:** Uses [Bubblewrap](https://wiki.archlinux.org/title/Bubblewrap) to provide a read-only filesystem view, a temporary `/tmp`, and no network access.

If the sandbox tool for the current platform is unavailable, the help scan runs without a sandbox. Bubblewrap is not installed by default on many Linux distributions, so installing it is strongly recommended when untrusted executables may be present on `PATH`. Curated specifications are downloaded as data and do not require executing the corresponding local command.

## Troubleshooting

### A command is not recognized

1. Confirm that the active editor language mode is **Shell Script** or **BitBake**.
2. If the command is in [general.txt](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt), run **Shell Completion: Load All Common CLI Specs**.
3. If it is in [bio.txt](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt), run **Shell Completion: Load All Bioinformatics CLI Specs**.
4. To discard a stale cached specification, run **Shell Completion: Remove Command Spec** and enter the command name. If `shellCompletion.scanUnknownCommands` is enabled, the next completion or hover request will try to recreate it from the local command.

Dynamic extraction can still fail when the command is unavailable on `PATH`, its help invocation exits unsuccessfully, or its output cannot be parsed.

### Suggestions are too aggressive

The completion provider uses the space character as a trigger. You can adjust VS Code's editor settings by disabling **Quick Suggestions** or **Suggest On Trigger Characters**.

These settings affect other language modes as well.

## Known Limitations

* BitBake support is experimental and requires another extension that provides the `bitbake` language mode.
* Windows and Alpine arm64 Extension Hosts are not currently supported by the bundled scanner.
* Completion and hover information depend on either a cached curated specification or, when unknown-command scanning is enabled, successful extraction from the local command's `--help` output.
