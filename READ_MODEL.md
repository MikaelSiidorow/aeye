# Read model

The read model is the stable server-side query boundary for dashboards and remote functions. It is implemented by `AeyeReadModel` in `src/lib/server/read-model.ts`.

## Accounting semantics

Dashboard totals describe the active conversation branch.

- Usage replayed between parent and subagent transcripts is excluded.
- Dead-branch usage is excluded from active totals and returned separately as `deadBranch`.
- Tool aggregates exclude calls sourced from replayed or dead-branch events.
- Session graphs contain both active and dead branches so the UI can render the DAG.
- Execution context contains only structured skill identifiers and category labels for scratchpads and worktrees.
- Session display names resolve from provider titles and subagent descriptions at read time. They are not stored in Aeye.
- A missing title falls back to at most eight words from the first meaningful user message.
- No method returns complete message bodies or complete tool inputs.

The database views encode the shared filters:

- `active_usage_events`
- `active_tool_calls`
- `session_read_model`

## Query surface

| Method                             | Result                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| `overview()`                       | Global project, session, turn, tool, token, and cost totals |
| `listProjects()`                   | Project summaries ordered by latest activity                |
| `listSessions(options)`            | Named, paginated session summaries with a project filter    |
| `usageByDay(options)`              | Active usage grouped in a requested IANA timezone           |
| `usageByModel(options)`            | Active usage and session counts grouped by model            |
| `toolUsage(options)`               | Tool status totals plus average, p50, and p95 duration      |
| `getSessionGraph(sessionId)`       | Safe event metadata and parent-child edges                  |
| `getSessionAnnotations(sessionId)` | Body-safe execution context with source event references    |
| `getSession(sessionId)`            | Session summary, context, links, usage, tools, and graph    |

Breakdown methods accept project and session filters. Session lists allow 1 to 500 results per page. Invalid identifiers, pagination values, and timezones fail at the query boundary.

## Validation

The synthetic oracle covers parent and subagent replay, a dead branch, pagination, four tool duration samples, graph edges, execution context, provider title precedence, bounded message previews, and the absence of complete private source content in serialized results.

The full-history validation database produced:

| Measurement        |     Result |
| ------------------ | ---------: |
| Projects           |          5 |
| Sessions           |         29 |
| Daily buckets      |          4 |
| Models             |          4 |
| Tool names         |         18 |
| Active tokens      | 71,146,209 |
| Dead-branch tokens |    270,320 |
| Six-query suite    |      94 ms |

The overview, daily, model, and session token totals reconciled exactly. All 37 repository tests and the full static check passed.
