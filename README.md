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
| **Shell Completion: Inspect Cursor Context** | Show parser and provider metadata for the active cursor in the **Shell Completion Debug** output channel. |
| **Shell Completion: Toggle Live Cursor Context** | Continuously show the provider-critical cursor metadata in the **Shell Completion Live Debug** output channel. |

Loading, updating, or bulk-removing a collection requires an internet connection because the extension fetches its current bundle or command index.

### Inspect Cursor Context

For completion and hover debugging, place the cursor at the position to inspect and run **Shell Completion: Inspect Cursor Context**. The command writes a JSON report to the **Shell Completion Debug** output channel and also returns that report to programmatic command callers. It includes:

* the tree-sitter node and ancestor chain, including grammar types, field names, ranges, error and missing-node flags, and parse states;
* the completion walkback position and redirect or error-recovery suppression reasons;
* the command invocation, resolved subcommand path, aliases, and resolver stop reason used by completion and hover; and
* the same observations from the incrementally cached tree and a fresh parse, with equivalence results for quick comparison.

The inspection follows the normal provider lookup path, so inspecting a command may populate its regenerable command-specification cache.

For a compact view that follows caret movement, document edits, and hover requests, run **Shell Completion: Toggle Live Cursor Context**. While enabled, the **Shell Completion Live Debug** output channel is replaced after each debounced update. Its header reports the editor caret and the latest cursor position that VS Code delivered to the hover provider as independent locations, followed by the completion and hover positions actually used for provider decisions. This makes both kinds of movement explicit: completion may walk back from the caret to recover command context, while hover is evaluated at the cursor rather than the caret. VS Code does not expose raw mouse-move events to extensions, so Cursor is shown as not observed until the first hover request and is refreshed on subsequent hover requests. The output contains only values used by completion or hover decisions: node type, text and command-field role; suppression and walkback state; command invocation; and subcommand resolution path, source ranges, aliases, and stop reason. Run the same command again to disable live inspection. Live inspection does not show grammar types, node IDs, or parse states because the providers do not consult them.

The H2O executable can also be selected with the `shellCompletion.h2oPath` setting. Its default value, `<bundled>`, uses the scanner packaged for the current platform.

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

* [tree-sitter](https://tree-sitter.github.io/tree-sitter/) identifies the command, subcommand, and option at the cursor.
* The extension first looks for a command specification in its in-memory cache, restored from a compressed snapshot in VS Code global storage. This on-disk cache is regenerable and is not synchronized through Settings Sync.
* The common curated collection is downloaded in the background when the extension activates. Existing cached entries are preserved unless you explicitly reload the collection.
* For an unknown command available in the local environment, the bundled [H2O](https://github.com/yamaton/h2o) scanner runs `<command> --help`, parses the output, and caches the result.
* Network requests and local help scans have a 10-second timeout.

When upgrading from a version that stored command specifications in VS Code global state, the extension discards those legacy cache entries instead of migrating them. It then rebuilds the cache from curated data or locally scanned help output.

## Security

Creating a specification for an unknown command executes that command with `--help`. A program found in an untrusted local environment could therefore present a risk.

The extension uses an operating-system sandbox when one is available:

* **macOS:** Uses `sandbox-exec` to deny filesystem writes and network access.
* **Linux and WSL:** Uses [Bubblewrap](https://wiki.archlinux.org/title/Bubblewrap) to provide a read-only filesystem view, a temporary `/tmp`, and no network access.

If the sandbox tool for the current platform is unavailable, the help scan runs without a sandbox. Bubblewrap is not installed by default on many Linux distributions, so installing it is strongly recommended when untrusted executables may be present on `PATH`. Curated specifications are downloaded as data and do not require executing the corresponding local command.

## Troubleshooting

### A command is not recognized

1. Confirm that the active editor language mode is **Shell Script** or **BitBake**.
2. If the command is in [general.txt](https://github.com/yamaton/h2o-curated-data/blob/main/general.txt), run **Shell Completion: Load All Common CLI Specs**.
3. If it is in [bio.txt](https://github.com/yamaton/h2o-curated-data/blob/main/bio.txt), run **Shell Completion: Load All Bioinformatics CLI Specs**.
4. To discard a stale cached specification, run **Shell Completion: Remove Command Spec** and enter the command name. The next completion or hover request will try to recreate it from the local command.

Dynamic extraction can still fail when the command is unavailable on `PATH`, its help invocation exits unsuccessfully, or its output cannot be parsed.

### Suggestions are too aggressive

The completion provider uses the space character as a trigger. You can adjust VS Code's editor settings by disabling **Quick Suggestions** or **Suggest On Trigger Characters**.

These settings affect other language modes as well.

## Known Limitations

* BitBake support is experimental and requires another extension that provides the `bitbake` language mode.
* Windows and Alpine arm64 Extension Hosts are not currently supported by the bundled scanner.
* Completion and hover information depend on either a cached curated specification or successful extraction from the local command's `--help` output.
