# Semantic Substrate Lab

The semantic substrate sidecar records local development context as hash-addressed semantic memory. It stores repair memories, diagnostics, explanations, graph facts, root snapshots, and cycle events under `.zero/context`.

## Storage Layout

```text
.zero/context/
  root.json
  roots/
    <root-hash>.json
  nodes/
    <node-hash>.json
  events/
    <event-hash>.json
  indexes/
    source-index.json
```

`.zero/context` is generated local state and remains ignored by git.

## Command Surface

```sh
npm run context -- <command> [options]
```

Implemented commands:

```text
init
capture-repair
capture-fix-plan
capture-check
capture-explain
capture-graph
project
verify
diff
events
timeline
compliance
policy
reconcile
check-cycle
```

Focused scripts also exist for common commands, including `context:init`, `context:capture-fix-plan`, `context:project`, `context:verify`, `context:events`, `context:timeline`, `context:compliance`, `context:policy`, `context:reconcile`, `context:check-cycle`, and `context:test`.

## Node Model

Nodes use deterministic canonical JSON hashing and are stored as `.zero/context/nodes/<hash>.json`.

Implemented node kinds:

- `repair-memory`
- `diagnostic-memory`
- `explain-residual`
- `graph-context`

Lifecycle states:

- `active`
- `superseded`
- `archived`

New node versions record parent hashes. Superseded nodes record the active successor through `lifecycle.supersededBy`. Archived nodes are removed from active projection and remain addressable by hash.

## Root History

`root.json` is the current pointer. Root snapshots live under `.zero/context/roots/<root-hash>.json`.

Root snapshots record:

- active node hashes
- superseded node hashes
- archived node hashes
- parent root hash
- reason
- index paths

Mutating capture and reconciliation actions create a new root snapshot. Unchanged captures keep the current root.

## Event Model

Context events live under `.zero/context/events/<event-hash>.json`. Event hashes use canonical JSON with `eventHash` excluded from its own hash payload.

Implemented event modes:

- `context-check-cycle`
- `context-reconcile`

Events record source file, previous root, current root, root transition status, captured node summaries, skipped entries, verification summary, and diagnostics.

## Timeline

`timeline --json` projects the event stream. `timeline --source <file> --json` filters by source file.

Timeline entries include:

- event id and event hash
- event hash verification status
- previous and current root existence
- root transition status
- captured and skipped summaries
- verification summary

The summary reports event count, root transitions, hash failures, and missing roots.

## Compliance

`compliance --json` verifies the current context state. `compliance --source <file> --json` scopes event review and anchor checks to a source while still verifying root integrity.

Compliance checks:

- root pointer and current root snapshot
- root snapshot hash
- parent root chain
- event hashes
- event root references
- active node hashes
- lifecycle consistency
- source anchors and exact-text preconditions
- source index consistency
- addressability of superseded nodes

## Policy

`policy --json` interprets compliance results.

Policy modes:

- `advisory`: reports compliance diagnostics and keeps policy success.
- `verified`: requires `compliance.ok`.
- `strict`: requires compliance, anchor success, intact timeline, lifecycle consistency, and source index consistency.

`check-cycle --policy advisory|verified|strict` runs capture, projection, verification, compliance, and policy evaluation in one operation.

## Reconciliation

`reconcile --source <file> --json` reports candidate actions for source drift.

Mutating actions:

```sh
reconcile --node <hash> --action archive --json
reconcile --node <hash> --action refresh-anchor --json
reconcile --node <hash> --action supersede --summary <text> --json
```

Reconciliation updates root history, source indexes, node lifecycle, and records a `context-reconcile` event.

## Capture Sources

The sidecar captures context from:

- `bin/zero fix --plan --json <file>`
- `bin/zero check --json <file>`
- `bin/zero explain --json <diagnosticCode>`
- `bin/zero graph --json <file-or-project>`

`capture-repair` remains a fixture shortcut for the TYP009 repair memory.

## Validation

```sh
npm run context:test
npm run command-contracts:local
npm run conformance:local
git diff --check
```

## Native Integration Boundary

The current substrate is a sidecar. The next native integration boundary is a compiler-facing context root attestation and development-time context policy checks. Runtime execution remains independent of context graph traversal.
