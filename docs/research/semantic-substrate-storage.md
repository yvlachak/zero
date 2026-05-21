# Semantic Substrate Storage Contracts

The sidecar stores semantic context under `.zero/context`. Storage is local, generated, and ignored by git.

## Layout

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

## Hashing

All substrate hashes use `sha256:<hex>`.

Canonical JSON rules:

- object keys are sorted
- array order is preserved
- primitive values use JSON encoding
- fields with `undefined` values are omitted

Node hashes exclude the node `hash` field. Event hashes exclude the event `eventHash` field. Root hashes are computed from the canonical root snapshot payload without a `contextRoot` field.

## Root Pointer

`root.json` is the movable current-root pointer.

```json
{
  "schemaVersion": 1,
  "currentRoot": "sha256:...",
  "previousRoot": "sha256:...",
  "rootPath": ".zero/context/roots/<root-hash>.json",
  "indexes": {
    "sourceIndex": ".zero/context/indexes/source-index.json"
  }
}
```

The pointer is updated by mutating commands after a new root snapshot is written.

## Root Snapshot

Root snapshots are stored at `.zero/context/roots/<root-hash>.json`.

```json
{
  "schemaVersion": 1,
  "contextRoot": "sha256:...",
  "parentRoot": "sha256:...",
  "reason": "capture-fix-plan",
  "activeNodes": ["sha256:..."],
  "supersededNodes": ["sha256:..."],
  "archivedNodes": ["sha256:..."],
  "nodes": ["sha256:..."],
  "createdAt": null,
  "indexes": {
    "sourceIndex": ".zero/context/indexes/source-index.json"
  }
}
```

`nodes` mirrors active node hashes for the current implementation. `activeNodes`, `supersededNodes`, and `archivedNodes` define lifecycle membership.

Root reasons:

- `init`
- `capture-repair`
- `capture-fix-plan`
- `capture-check`
- `capture-explain`
- `capture-graph`
- `reconcile`
- `manual`

## Node Contract

Nodes are stored at `.zero/context/nodes/<node-hash>.json`.

Common fields:

```json
{
  "schemaVersion": 1,
  "kind": "repair-memory",
  "nodeId": "ctx:repair-memory:typ009:make-binding-mutable",
  "codes": ["DIAGNOSTIC_REPAIR"],
  "residualSummary": "Change the root binding to let mut before passing it to a mutable API.",
  "projection": {
    "kind": "context-projection",
    "frontier": {
      "diagnostics": ["TYP009"],
      "repairs": ["make-binding-mutable"],
      "edits": []
    }
  },
  "parents": [],
  "lifecycle": {
    "state": "active",
    "supersedes": [],
    "supersededBy": null
  },
  "hash": "sha256:..."
}
```

Node kinds:

- `repair-memory`
- `diagnostic-memory`
- `explain-residual`
- `graph-context`

Lifecycle states:

- `active`: projected by default and indexed when source-anchored.
- `superseded`: addressable old version with a successor in `supersededBy`.
- `archived`: addressable retired version removed from active projection.

## Source Anchor

Source-anchored nodes include:

```json
{
  "sourceAnchor": {
    "path": "conformance/native/fail/mem-copy-immutable-dst.0",
    "range": {
      "start": { "line": 2, "column": 5 },
      "end": { "line": 2, "column": 8 },
      "columnUnit": "utf8-byte"
    },
    "sourceHash": "sha256:...",
    "status": "active"
  }
}
```

Anchor verification checks:

- file exists
- current file hash matches `sourceHash`
- anchor range extracts valid text
- exact-text preconditions match extracted text

## Source Index

`.zero/context/indexes/source-index.json` maps source paths to active source-anchored node hashes.

```json
{
  "schemaVersion": 1,
  "sources": {
    "conformance/native/fail/mem-copy-immutable-dst.0": [
      "sha256:..."
    ]
  }
}
```

The index points to active nodes only. Superseded and archived nodes remain addressable by root snapshots and node files.

## Event Contract

Events are stored at `.zero/context/events/<event-hash>.json`.

```json
{
  "schemaVersion": 1,
  "kind": "context-event",
  "eventId": "ctx:event:000001",
  "eventHash": "sha256:...",
  "mode": "context-check-cycle",
  "sourceFile": "conformance/native/fail/mem-copy-immutable-dst.0",
  "previousRoot": "sha256:...",
  "currentRoot": "sha256:...",
  "rootChanged": true,
  "captured": [
    {
      "nodeId": "ctx:repair-memory:typ009:make-binding-mutable",
      "hash": "sha256:...",
      "action": "added"
    }
  ],
  "skipped": [],
  "verification": {
    "ok": true,
    "checkedNodes": 1
  },
  "diagnostics": []
}
```

Event modes:

- `context-check-cycle`
- `context-reconcile`

## Invariants

- `root.json.currentRoot` points to an existing root snapshot for compliant contexts.
- Root snapshot hashes match canonical root payloads.
- Root snapshots form a parent chain ending at an initial root.
- Active nodes listed by the current root exist and hash correctly.
- Source index entries point only to active source-anchored node hashes.
- Superseded and archived nodes remain addressable by hash.
- Events hash correctly and reference existing roots for compliant contexts.
- Reconciliation actions that mutate context advance the root and record an event.
