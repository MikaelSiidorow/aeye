# Local fixtures

`raw/` is a byte-for-byte snapshot of the available Claude Code project history.
`corpus/` contains all 20 JSONL files from that snapshot because the surviving
history is already small and each file may preserve a useful format variant.

The corpus includes the oldest and newest available sessions, 15 subagent
transcripts, forked sessions, interrupted sessions, a tiny session, and the
largest session. No surviving file contains a `summary` event or another clear
compaction marker. Add a compaction fixture when one becomes available.

Both data directories are gitignored because they contain private session data.
Run `scripts/redact.ts` only after its redaction policy is implemented.
