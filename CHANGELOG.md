# Change Log

All notable changes to the "vscode-h2o" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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