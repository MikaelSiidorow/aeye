# Validation

Validated on July 23, 2026 with Node 26.5.0 and ccusage 20.0.18.

## Frozen corpus

The source directories were copied once before validation. This kept the active Codex rollout
from changing between reindex passes.

| Source      | Files |   Size |
| ----------- | ----: | -----: |
| Claude Code |    30 |  15 MB |
| Codex       |   439 | 562 MB |

The indexed result contained:

| Table         |    Rows |
| ------------- | ------: |
| Projects      |      29 |
| Sessions      |     469 |
| Events        | 175,588 |
| Tool calls    |  37,924 |
| Session stats |     469 |
| Session links |      17 |

## Reindex determinism

Two full `--reindex` passes ran against the same frozen source copy.

| Pass   | Claude |     Codex | Failed files |
| ------ | -----: | --------: | -----------: |
| First  | 601 ms | 14,659 ms |            0 |
| Second | 588 ms | 16,682 ms |            0 |

SHA-256 hashes over ordered rows matched for projects, sessions, events, tool calls,
annotations, session stats, and session links. The normalized and derived data is
byte-identical after replay.

The `files` table is not part of the derived-data oracle. Its `last_ingested_at` value records
the replay time and therefore changes on every pass.

A scan after the second replay queued no files and inserted no events. The Claude scan took
25 ms and the Codex scan took 108 ms.

## ccusage reconciliation

ccusage was run against the same frozen Claude directory in UTC:

```sh
CLAUDE_CONFIG_DIR=/tmp/aeye-validation/claude-config \
  pnpm dlx ccusage@20.0.18 claude daily --json --offline --timezone UTC
```

| View                          |      Tokens | Difference from ccusage |
| ----------------------------- | ----------: | ----------------------: |
| ccusage                       | 144,268,878 |                       0 |
| Aeye, all unique usage events | 144,268,878 |                       0 |
| Aeye, active branches         | 143,998,558 |      -270,320 (-0.187%) |

Claude transcripts can replay the same API response in parent and sidechain logs. ccusage
deduplicates these responses. Aeye keeps every event row and marks replayed usage with
`is_usage_duplicate`. The snapshot contained 2,037 usage events. Of these, 1,049 were replay
copies and 988 were canonical usage events.

The "all unique" view excludes those replay copies. Its totals match ccusage exactly for every
token category, day, and model.

The active-view difference is one dead `claude-sonnet-5` branch from July 5:

| Breakdown         |    ccusage | Aeye active | Difference |
| ----------------- | ---------: | ----------: | ---------: |
| July 5            | 42,450,738 |  42,180,418 |   -270,320 |
| `claude-sonnet-5` |  3,278,022 |   3,007,702 |   -270,320 |

Every other day and model matches exactly. ccusage counts the dead branch. Aeye preserves its
usage in `tok_dead_branch` but excludes it from active totals. Adding the dead-branch tokens
back produces the exact ccusage result.

## Live tail

A controlled complete line was appended to format-valid temporary Claude and Codex
transcripts while the production watchers were running.

| Source      | Settle threshold | Update latency | Result |
| ----------- | ---------------: | -------------: | ------ |
| Claude Code |           300 ms |         316 ms | Pass   |
| Codex       |           300 ms |         316 ms | Pass   |

Both appended events were indexed and derived within one second. No real provider transcript
was modified for this test.

## Live UI

The app was started against isolated Claude, Codex, and database paths. An overview
`query.live` stream remained open while a complete Claude event was appended. The watcher
indexed and derived the event, then the same stream returned an updated snapshot without a
navigation or manual refresh.

The app held its database writer lock for the full run. A concurrent ingestion command for
the same database stopped with a readable process-specific error. Releasing the runtime
closed both watchers and its stream subscriber. A stale lock was recovered on the next start.

## Execution context

The 20-file representative Claude corpus produced 30 annotations from structured fields and
safe path categories. The graverun child session
`0df2f937-2cc7-4976-bbf5-2512f2cbb327:agent:agent-a843805ee9e65b8ad` was labeled
`codex:codex-rescue`. Its annotation references event 883 in the parent session, which is the
matching Agent spawn event for `toolu_01CqjJuprgg7EKFq4pG9iE6J`.

The corpus also recognized `codex:gpt-5-4-prompting`, `codex:rescue`, `deep-research`, and five
scratchpad uses. Unqualified `general-purpose` agents were excluded. A second annotation
derivation preserved every row and primary key. The read model and rendered session page
contained the skill identifier without exposing descriptions, prompts, arguments, command
bodies, or scratchpad filenames.

## Repository checks

```sh
pnpm test
pnpm check
pnpm build
```

All 35 tests passed. Formatting, lint, type-aware lint, Svelte diagnostics, TypeScript checks,
and the production build passed.

## Result

The M5 validation oracle passes. Full replay is deterministic, Claude accounting reconciles
exactly with ccusage after the documented branch-liveness difference, and live tail updates
arrive within one second. The M9 live UI oracle also passes for stream updates, targeted
project filtering, reconnect state, singleton watcher cleanup, and database writer exclusion.
The M10 execution-context oracle passes for structured skill provenance, scratchpad and
worktree categories, idempotent derivation, and body-free rendering.
