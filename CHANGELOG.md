# Change Log

## [0.0.20]
- Rename command "Load General-Purpose CLI Data" to "Load Common CLI Data"

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