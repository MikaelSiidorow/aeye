# Slice 0 validation

Validated on 2026-07-14 with Node 26.5.0, pnpm 11.13.0, ccusage 20.0.17, and the `Europe/Berlin` reporting timezone.

## Full-history index

The validation database was rebuilt from `~/.claude/projects`.

| Measurement            |   Result |
| ---------------------- | -------: |
| Projects               |        5 |
| Sessions               |       29 |
| Files                  |       29 |
| Events                 |    3,534 |
| Tool calls             |      729 |
| Ingestor duration      |   680 ms |
| Whole command duration | 1,474 ms |
| Failed files           |        0 |

A scan immediately after the rebuild queued no files, inserted no events, and completed in 41 ms.

## ccusage reconciliation

The comparison used:

```sh
pnpm dlx ccusage claude daily --json --breakdown \
  --timezone Europe/Berlin --offline
```

Claude transcripts can replay the same API response in parent and sidechain logs. ccusage deduplicates these usage records by message and request identity. If one copy is a sidechain entry, it prefers the non-sidechain copy. Aeye now preserves every event row and marks replayed usage with `is_usage_duplicate`.

The snapshot contained 1,402 events with usage, of which 735 were replay copies and 667 were canonical usage records.

| Token category |    ccusage | Aeye canonical | Delta |
| -------------- | ---------: | -------------: | ----: |
| Input          |     89,952 |         89,952 |     0 |
| Output         |    406,776 |        406,776 |     0 |
| Cache read     | 68,764,314 |     68,764,314 |     0 |
| Cache write    |  2,155,487 |      2,155,487 |     0 |
| Total          | 71,416,529 |     71,416,529 |     0 |

Daily totals also matched exactly:

| Berlin date |    ccusage | Aeye canonical | Delta |
| ----------- | ---------: | -------------: | ----: |
| 2026-07-05  | 42,450,738 |     42,450,738 |     0 |
| 2026-07-06  |  5,866,643 |      5,866,643 |     0 |
| 2026-07-09  | 12,649,705 |     12,649,705 |     0 |
| 2026-07-14  | 10,449,443 |     10,449,443 |     0 |

Model totals matched exactly:

| Model           |    ccusage | Aeye canonical | Delta |
| --------------- | ---------: | -------------: | ----: |
| claude-fable-5  | 67,969,045 |     67,969,045 |     0 |
| claude-sonnet-5 |  3,234,685 |      3,234,685 |     0 |
| claude-opus-4-8 |    212,799 |        212,799 |     0 |

`session_stats` intentionally describes only the active conversation branch. Its total was 71,146,209 tokens. The 270,320-token difference from ccusage exactly matched `tok_dead_branch`, so the remaining divergence is accounted for by branch semantics rather than parsing loss.

## Live tail

The watcher was started against the real Claude tree. Its cold scan completed successfully, but no natural source write occurred during a 35-second read-only observation window.

The same watcher was then exercised end to end against a temporary Claude-format transcript. A complete appended event reached both `events` and the recomputed `session_stats` in 325 ms. The resulting token totals included the appended event. This is below the one-second oracle.

## Verification

```sh
pnpm test
pnpm run check
```

All 17 tests passed. Formatting, lint, type-aware lint, and TypeScript checks passed.
