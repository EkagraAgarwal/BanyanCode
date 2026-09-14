# BanyanCode Agent-Efficiency Telemetry

## Scope

BanyanCode records detailed agent-efficiency telemetry locally so a run can answer:

> Did spawning this agent improve the final result enough to justify its uncached context, output, latency, and duplicated work?

This telemetry is not installation telemetry. It is not sent to PostHog or any other remote service. The ledger is local application data and may contain sensitive operational metadata.

The first implementation measures lifecycle, token, cache, cost, tool, finding, and outcome data. Prompt-segment overlap, causal critical-path analysis, and semantic usefulness are later phases because they require additional provenance that the MVP does not yet have.

## Privacy Boundary

The default ledger MUST NOT contain:

- Prompts, completions, system instructions, or model reasoning text.
- Raw tool arguments, tool results, credentials, or provider response IDs.
- Absolute paths, usernames, hostnames, or other machine identifiers.

Repository targets are represented by a keyed local identifier when they are needed for later overlap analysis. A plain content hash is insufficient because common paths and templates can be dictionary-tested. Any path capture must be an explicit local configuration choice.

Telemetry failures MUST be isolated from the user operation. Recording is best effort and MUST NOT delay model streaming, tool execution, or agent completion.

## Event Envelope

Every event has a versioned, append-only envelope:

```ts
{
  schemaVersion: 1
  eventID: string
  eventType: string
  occurredAt: number

  runID: string
  sessionID?: string
  parentSessionID?: string
  rootSessionID?: string
  agentInstanceID?: string
  agentRole?: string
  depth?: number

  taskID?: string
  benchmarkID?: string
  experimentID?: string
  experimentVariant?: string

  modelCallID?: string
  toolCallID?: string
  findingID?: string
  parentEventID?: string

  status?: "started" | "succeeded" | "failed" | "aborted"
  durationMs?: number
  errorCategory?: string
  metadata?: { _v: 1, data: Record<string, unknown> }
}
```

IDs are random correlation identifiers. They MUST NOT be derived from prompt, completion, path, or other user content. Existing session parent/child relationships remain the canonical agent hierarchy.

The event ID must be stable for a retry of the same logical write. Replays therefore use conflict-safe insertion rather than creating a second event.

## Event Types

The MVP supports these event classes:

```text
run.started       run.finished       run.failed        run.aborted
agent.spawned     agent.started      agent.finished   agent.failed
agent.aborted
model.started     model.finished     model.failed     model.aborted
tool.started      tool.finished      tool.failed
finding.recorded  finding.delivered  finding.consumed  finding.cited
finding.verified  finding.rejected
outcome.recorded
```

Terminal events are recorded for success, failure, cancellation, and abort when the lifecycle seam can distinguish them. Missing provider usage remains unknown rather than zero.

## Model Usage

Model terminal events may include:

```text
provider
requested_model
response_model
input_tokens
cached_input_tokens
cache_write_tokens
uncached_input_tokens
output_tokens
reasoning_tokens
total_tokens
input_cost
cached_input_cost
output_cost
total_cost
latency_ms
time_to_first_token_ms
stop_reason
retry_count
```

Provider-reported cache-read and cache-write counts are subsets of total input tokens. Aggregates use sums:

```text
realized_cache_read_ratio = sum(cached_input_tokens) / sum(input_tokens)
```

The ratio is unknown when the provider does not report the required fields. It is not a savings estimate and is not averaged across calls.

## Tools And Findings

Tool events record the tool identity, status, duration, bounded error category, cache classification, and repository result counts where applicable:

```text
files_returned
symbols_returned
directories_returned
nodes_returned
edges_returned
result_tokens
result_size_bytes
```

Raw inputs and outputs remain outside the ledger. Finding utilization is counted only after an explicit consume/cite/verify event references the finding. Receipt or delivery alone is not utilization.

## Retention And Storage

The ledger uses the BanyanCode SQLite database with an additive migration, WAL-safe writes, and indexes for run, session, agent, event type, and time-range queries.

Default bounds are:

```text
retention: 30 days
maximum events: 100000
```

Implementations may sample verbose non-terminal events deterministically when a bound is reached, but MUST preserve terminal, failure, and abort events. Cleanup MUST only delete telemetry rows and MUST NOT modify sessions, messages, plans, goals, memories, or tool-adoption data.

Local telemetry can be disabled. Disabled mode performs no ledger writes and does not affect the operation being measured.

## Derived Metrics

The MVP reports:

- Run status and duration.
- Agent count, role counts, fan-out, and maximum depth.
- Model calls, token totals, uncached tokens, cache-read ratio, cost, and latency.
- Tool count, success/failure rate, and latency.
- Findings produced and explicitly consumed.
- Outcome status and test/benchmark results when supplied.
- Descendant work and token totals for spawn amplification.

Later metrics MUST be labelled as measured or inferred:

```text
file_overlap                 presented-context overlap, not attention
context_overlap              token-weighted presented-context overlap
handoff_reverification       explicit verification or suspected proxy
duplicate_discovery_tokens  attributed duplicate work or proxy
critical_path                longest complete causal path, or unknown
```

No metric may claim that a spawn, reverification, or duplicate discovery was harmful without an outcome comparison.

## Experiments

Benchmark runs carry low-cardinality configuration metadata:

```text
experiment_id
variant
assignment_source
scouts_enabled
max_scouts_per_parent
max_agent_depth
recursive_researchers
scout_token_budget
prompt_layout_version
agent_config_version
```

Compare fixed scenarios with paired, randomized baseline and feature-off arms. Primary outcomes are task success, verifier/test pass rate, billed and uncached tokens, cost, wall time, and critical-path time when known. Overlap and handoff metrics are explanatory secondary outcomes.
