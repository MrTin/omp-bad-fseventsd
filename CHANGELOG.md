# Changelog

All notable changes. Versions follow [semver](https://semver.org); tags are `vX.Y.Z`.

## Unreleased

## 0.1.0 - 2026-11-26

- Measure `fseventsd` every 10 minutes (one omp process, no root); warn in every interactive session above `limitGB` (default 5% of RAM, at least 2 GB).
- `/fsnuke`: list the apps holding an event stream, ask, restart through a root helper, report what did not reconnect and which directories the recent events came from.
- `/fsnuke install` / `uninstall`: the root helper and a sudoers rule for exactly its two commands, via macOS's password dialog. The helper restarts only above 1 GB, at most once per 30 minutes, and logs every call.
- Sessions whose own processes lost their event stream get a note for their agent.
