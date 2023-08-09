# Change Log
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