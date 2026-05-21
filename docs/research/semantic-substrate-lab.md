# Semantic Substrate Lab

The semantic substrate sidecar records local development context as hash-addressed semantic memory. It stores repair memories, diagnostics, explanations, graph facts, root snapshots, timeline events, policy results, and reconciliation history under `.zero/context`.

This research branch implements the substrate as a local sidecar. Native compiler integration is limited to reading existing `bin/zero` JSON command output.

## Documents

- [Storage Contracts](./semantic-substrate-storage.md): `.zero/context` layout, node schemas, root snapshots, events, source index, hashing rules, and invariants.
- [Command Surface](./semantic-substrate-commands.md): implemented commands, mutation behavior, exit behavior, and examples.
- [Compliance And Policy](./semantic-substrate-compliance.md): timeline verification, compliance checks, policy modes, diagnostics, and enforcement semantics.
- [Reconciliation](./semantic-substrate-reconciliation.md): drift detection, archive, refresh-anchor, supersede, root updates, and event records.
- [Context-Bearing Compilation](./context-bearing-compilation.md): development-time context model, artifact attestation boundary, and native integration path.
- [Whitepaper Alignment](./semantic-substrate-whitepaper-alignment.md): mapping from the broader Semantic Merkle Substrate thesis to this sidecar implementation.
- [Current Whitepaper](./zero-semantic-merkle-substrate-whitepaper.md): implementation-grounded architecture paper for the current sidecar and native integration boundary.

## Implemented Capabilities

- deterministic canonical JSON hashing
- hash-addressed semantic nodes
- root snapshots and parent root lineage
- movable `root.json` current-root pointer
- source index for active source-anchored nodes
- source anchor verification and exact-text precondition checks
- node lifecycle states: `active`, `superseded`, `archived`
- node lineage through `parents`, `supersedes`, and `supersededBy`
- event records for check cycles and reconciliation
- timeline projection with event/root verification metadata
- compliance verification across roots, events, nodes, anchors, lifecycle, and source index
- policy modes: `advisory`, `verified`, `strict`
- reconciliation actions: `archive`, `refresh-anchor`, `supersede`
- capture from `fix --plan`, `check`, `explain`, and `graph`

## Storage Summary

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

## Command Summary

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

## Validation

```sh
npm run context:test
npm run command-contracts:local
npm run conformance:local
git diff --check
```

## Native Integration Boundary

The next native integration boundary is a compiler-facing context root attestation and development-time policy check. Build artifacts can later carry a context root. Development tools can restore and verify that root and its timeline. Runtime execution remains independent of context graph traversal.
