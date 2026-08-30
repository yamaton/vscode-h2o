# Change Log

## [Unreleased]

## [0.3.1] (2026-08-30)

- Publish Windows x64 and arm64 packages without H2O or local `--help` scanning. Downloaded and cached completion and hover data remain available, and Windows users are not prompted to enable local scans.

## [0.3.0] (2026-08-30)

- Distribute platform-specific packages, adding Linux arm64, Alpine x64, and macOS arm64 support while retaining Linux x64 and macOS x64.
- Update the bundled command-help parser to the pinned and verified v0.6.0 release.
- Use a POSIX `sh` wrapper so the bundled command-help parser works in minimal Linux environments such as Alpine.
- Allow commands scanned in the macOS sandbox to write to `/dev/null` and `/dev/full` while continuing to block other filesystem writes and network access.
- Keep extension activation responsive while common command specifications download in the background.
- Batch curated command updates and coordinate initial cache availability before local help fallback.
- Complete partial command names directly from the available command list, including one-character and wrapped command input, without starting a local `--help` scan.
- Avoid command-specification lookups before or within the effective command name, including wrapped commands, so unrelated local scans are not started.
- Store command specifications as a versioned compressed snapshot in VS Code global storage instead of Memento. The snapshot is replaced through a unique temporary file and a best-effort overwrite rename. Existing command caches are reset once on upgrade and rebuilt from curated data or local command-help parsing.
- Run local `--help` scans asynchronously without blocking the Extension Host, coalesce duplicate requests, serialize distinct scans, clean up failed scanner processes, and terminate scanner process groups on cancellation, timeout, or excessive output, addressing [Issue #11](https://github.com/yamaton/vscode-h2o/issues/11).
- Add 10-second timeouts to remote specification requests and local scans, cap each local scan output stream at 1 MiB, and wait for cache writes and bulk removals to finish.
- Add automated unit, integration, native-binary, VSIX-content, dependency, and Marketplace release checks.
- Reorganize the README as a landing page with detailed coverage, platform, security, management, and troubleshooting documentation below the introduction.
- Update the Marketplace description, categories, and search keywords to reflect completion, hover, and BitBake support.
- Raise the minimum supported VS Code version to 1.101, aligning the extension API and Node.js types with its Node.js 22 Extension Host.
- Update runtime and development dependencies, including the Tree-sitter runtime and Bash grammar.
- Fix completion and hover lookup for commands preceded by environment variable assignments.
- Resolve common simple and nested `sudo` or `nohup` wrapper forms without broadly interpreting wrapper options.
- Resolve subcommands from left to right through their direct hierarchy, including aliases and `--`, so later positional or unresolved words are not promoted to subcommands.
- Keep completion and hover available for commands inside command and process substitutions embedded in redirects while suppressing ordinary redirect targets, heredocs, and unsafe parser-recovery regions.
- Return no hover for ordinary lookup misses instead of rejecting the provider request, preventing the `provider FAILED` and `No hover is available` messages described in [Issue #12](https://github.com/yamaton/vscode-h2o/issues/12).
- Restrict trusted command links in hover content to the cache-reset command.
- Release superseded syntax trees, retain request-local copies during asynchronous completion and hover work, and ignore unrelated language edits to prevent WebAssembly memory growth and invalid tree access.
- Correct incremental parse coordinates for shortening, batched, CRLF, and Unicode edits, and avoid stack exhaustion when walking back across long runs of whitespace.
- Coalesce syntax-tree parsing after document edits, parse unused documents lazily, and limit parser-backed features for very large documents by default through `shellCompletion.maxDocumentCharacters` to keep the Extension Host responsive.
- Add opt-in live Completion, Hover, and Tree-sitter diagnostic views, caret and cursor inspection commands, read-only snapshots, and pause and resume controls.
- Add the machine-scoped `shellCompletion.scanUnknownCommands` setting, disabled by default, and offer the choice on activation when no explicit setting or prior response exists before enabling local `--help` execution. Downloaded and cached command specifications remain available while disabled, and disabling the setting immediately cancels queued or running scans.
- Add the window-scoped `shellCompletion.enableCompletion` setting to unregister this extension's completion suggestions and space trigger without disabling hover, addressing [Issue #13](https://github.com/yamaton/vscode-h2o/issues/13).
- Treat `shellCompletion.h2oPath` as a machine-scoped path to the local command-help parser so workspace settings cannot replace the executable used by the Extension Host.

## [0.2.15] (2023-11-04)
- Add experimental support of Bitbake per [Issue #10](https://github.com/yamaton/vscode-h2o/issues/10)

## [0.2.14] (2023-10-14)
- Update README with instruction that Command Palettes work only in "Shell Script" mode.

## [0.2.13] (2023-10-11)
- Fix [Issue #8](https://github.com/yamaton/vscode-h2o/issues/8) thanks to [@vdesabou](https://github.com/vdesabou)

## [0.2.12] (2023-09-09)
- Fix the extension not activated on WSL2 with dependency updates

## [0.2.11] (2023-08-10)
- Fix Runtime errors in edits and saves

## [0.2.10] (2023-08-09)
- Do not flood logs when command specs are handled in batch
- Update dependencies for security
- Rephrase README
- (Fix dates in this change log)

## [0.2.9] (2023-02-07)
- Fix problems by removing unnecessary entries in package.json

## [0.2.8] (2023-02-07)
- Improve command usage and TLDR formatting
- Handle commands starting with `nohup`

## [0.2.7] (2023-02-02)
- Fix hover over unregistered old-style options

## [0.2.6] (2023-01-28)
- Show usage in hovers
- Show description in hovers when appropriate
- Update `h2o` (command spec parser) to v0.4.6

## [0.2.5] (2022-12-29)
- Fix completion range discussed in https://github.com/yamaton/h2o-curated-data/issues/2

## [0.2.4] (2022-10-24)
- Fix completion shown after semicolons.

## [0.2.3] (2022-03-18)
- Update README

## [0.2.2] (2022-03-18)
- Fix an error when loading a command without an argument.

## [0.2.1] (2022-03-17)
- Show "tldr" pages at the command hover if available in the command spec
- Support `tldr`, `inheritedOptions`, and `aliases` fields in the command spec.

## [0.2.0] (2022-03-02)
- Add "Shell Commands" Explorer view
- Fix to work with built-in commands like echo and hash
- Fix case in the title to "Shell script command completion"
- Update publisher name / email address

## [0.1.3] (2022-02-23)
- Fix ridiculously long loading of CLI packages
- Remove redundant operations

## [0.1.2] (2022-02-23)
- Add loading individual command spec from 'experimental'
- Fix broken links in downloading CLI packages (general and bio)
- Bump H2O to v0.3.2

## [0.1.1] (2022-01-28)
- Remove unused dev dependencies

## [0.1.0] (2021-12-18)
- Support multi-level subcommands
- Rename package to "Shell Script command completion"
- Bump H2O to v0.2.0

## [0.0.20] (2021-07-22)
- Rename command "Load General-Purpose CLI Data" to "Load Common CLI Data"
- Suppress command-name completion after typing space
- Bump H2O to v0.1.18
    - Use sandboxing on macOS with `sandbox-exec`
    - Filter duplicate options with hand-engineered score

## [0.0.19] (2021-07-18)
- Fix icon

## [0.0.18] (2021-07-18)
- Bump H2O to v0.1.17
    - Fix a bug in checking manpage availability
    - Add more help query scanning
    - Minior fixes
    - **[WARNING]** temporary disable sandboxing for performance
- Add icon (Credit: https://www.irasutoya.com/)

## [0.0.17] (2021-07-14)
- Show description in all lines of subcommand and option/flag completions
- Bump H2O to v0.1.15
    - Bugfixes

## [0.0.16]
- Bump H2O to v0.1.14
    - Much better macos support
    - Improved parsing

## [0.0.15]
- Support the multi-lined command where continued line ends with `\`
- Fix hover not working on `--option=arg`
- Fix hover not working on a short option immediately followed by an argument `-oArgument`
- Fix completion candidates not ignoring properly after `--option=arg`

## [0.0.14]
- Bump H2O to v0.1.12
    - Bugfixes and performance improvements
- Introduce non-alphabetical ordering of completion items
    - Subcommands appear before options
    - Ordering respects the source

## [0.0.13]
- Remove command "Download and Force Update Local CLI Data"
- Add command "Load General-Purpose CLI Data"
- Add command "Load Bioinformatics CLI Data"
- Add command "Remove Bioinformatics CLI Data"

## [0.0.12]
- Suppress command completion when other completions are available

## [0.0.11]
- Reintroduce command completion
- Add command "Download and Force Update Local CLI Data"
- Bugfixes including crash when disconnected

## [0.0.10]
- Revert to 0.0.8+

## [0.0.9]
- Add command completion
- Code refactoring

## [0.0.8]
- Change the display name to "Shell Completion"
- Fix the bug not showing completions in some cases.

## [0.0.7]
- Fix a critical bug not showing completions properly
- Bump H2o to v0.1.10
    - Bugfixes

## [0.0.6]
- Fetch curated data from GitHub at startup
- Bump H2o to v0.1.9
    - Use Bubblewrap (sandbox) in Linux if available
    - Fail fast than producing junk
- Change message formatting in Hover

## [0.0.5]
- Fix link in README

## [0.0.4]
- Add completion and hover GIF to README

## [0.0.3]
- Bundle macos executable, in addition to linux
- Bump H2O to v0.1.7
- Make path to H2O configurable (default: "<bundled>")

- Initial release
