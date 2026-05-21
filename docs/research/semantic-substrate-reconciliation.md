# Semantic Substrate Reconciliation

Reconciliation responds to detected semantic context drift. Source reconciliation is read-only. Node actions mutate context only when an explicit action is provided.

## Source Reconciliation

```sh
npm run context -- reconcile --source <file> --json
```

Output mode: `context-reconcile`

Happy path:

```json
{
  "schemaVersion": 1,
  "mode": "context-reconcile",
  "ok": true,
  "sourceFile": "conformance/native/fail/mem-copy-immutable-dst.0",
  "actions": [],
  "diagnostics": []
}
```

When source verification reports drift, source reconciliation emits candidate actions.

Candidate examples:

```json
{
  "nodeId": "ctx:repair-memory:typ009:make-binding-mutable",
  "hash": "sha256:...",
  "action": "refresh-anchor",
  "reason": "CTX_PRECONDITION_MISMATCH"
}
```

Source reconciliation does not mutate roots, nodes, events, or indexes.

## Archive

```sh
npm run context -- reconcile --node <hash> --action archive --json
```

Archive behavior:

- requires an active node
- marks the node lifecycle as `archived`
- removes the node from `activeNodes`
- adds the node to `archivedNodes`
- rebuilds the active source index
- writes a new root snapshot with `reason: "reconcile"`
- writes a `context-reconcile` event

Archived nodes remain addressable by hash. Source projection omits archived nodes.

## Refresh Anchor

```sh
npm run context -- reconcile --node <hash> --action refresh-anchor --json
```

Refresh-anchor behavior:

- requires an active source-anchored node
- reads the first exact-text precondition from the node projection
- searches the same source file for that text
- updates `sourceAnchor.range` when the text appears exactly once
- updates `sourceAnchor.sourceHash`
- creates a new active node version
- marks the old node superseded
- updates root history and source index
- records a `context-reconcile` event

The action does not mutate source files.

Limitations:

- exact-text relocation must be unique
- ambiguous matches fail
- missing matches fail
- multi-line relocation is not implemented

## Supersede

```sh
npm run context -- reconcile --node <hash> --action supersede --summary <text> --json
```

Supersede behavior:

- requires an active source-anchored node
- creates a new active node version with the provided `residualSummary`
- sets `parents` to the old hash
- sets `lifecycle.supersedes` to the old hash
- marks the old node lifecycle as `superseded`
- sets old node `lifecycle.supersededBy` to the new hash
- writes a new root snapshot
- rebuilds source index
- records a `context-reconcile` event

## Root And Event Effects

Mutating reconciliation actions create root transitions:

```json
{
  "rootTransition": {
    "previousRoot": "sha256:...",
    "currentRoot": "sha256:...",
    "changed": true
  }
}
```

Reconcile events use mode `context-reconcile`:

```json
{
  "mode": "context-reconcile",
  "sourceFile": "conformance/native/fail/mem-copy-immutable-dst.0",
  "previousRoot": "sha256:...",
  "currentRoot": "sha256:...",
  "rootChanged": true,
  "captured": [
    {
      "nodeId": "ctx:repair-memory:typ009:make-binding-mutable",
      "hash": "sha256:...",
      "action": "superseded"
    }
  ]
}
```

## Diagnostics

- `CTX_RECONCILE_NO_ACTION`
- `CTX_RECONCILE_NODE_NOT_FOUND`
- `CTX_RECONCILE_NODE_NOT_ACTIVE`
- `CTX_RECONCILE_ANCHOR_NOT_FOUND`
- `CTX_RECONCILE_ANCHOR_AMBIGUOUS`
- `CTX_RECONCILE_UNSUPPORTED_ACTION`
- `CTX_RECONCILE_SOURCE_VERIFY_FAILED`

Reconciliation also preserves verification diagnostics that motivate candidate actions, including:

- `CTX_SOURCE_MISSING`
- `CTX_SOURCE_HASH_MISMATCH`
- `CTX_ANCHOR_RANGE_INVALID`
- `CTX_PRECONDITION_MISMATCH`

## Lifecycle Outcomes

| Action | Old node | New node | Root effect |
| --- | --- | --- | --- |
| `archive` | `archived` | none | remove from active, add to archived |
| `refresh-anchor` | `superseded` | `active` | replace active hash |
| `supersede` | `superseded` | `active` | replace active hash |

## Operational Notes

Reconciliation is explicit. Drift detection through `reconcile --source` proposes actions. Mutating actions require `--node` and `--action`.

Each mutating action advances root history and leaves old node files in storage. This keeps previous semantic states available for diff, timeline review, and compliance checks.
