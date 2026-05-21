# Semantic Substrate Compliance And Policy

Compliance verifies that the current semantic context can be trusted as development-time memory. Policy interprets compliance into advisory or enforceable modes.

## Timeline Verification

The timeline is a read model over context events.

```sh
npm run context -- timeline --json
npm run context -- timeline --source <file> --json
```

Each timeline entry includes:

```json
{
  "eventId": "ctx:event:000001",
  "eventHash": "sha256:...",
  "eventHashOk": true,
  "mode": "context-check-cycle",
  "sourceFile": "conformance/native/fail/mem-copy-immutable-dst.0",
  "previousRoot": "sha256:...",
  "previousRootExists": true,
  "currentRoot": "sha256:...",
  "currentRootExists": true,
  "rootChanged": true,
  "captured": [],
  "skipped": [],
  "verification": {
    "ok": true,
    "checkedNodes": 1
  }
}
```

The summary reports:

- `events`
- `rootTransitions`
- `hashFailures`
- `missingRoots`

Timeline diagnostics:

- `CTX_TIMELINE_EVENT_MALFORMED`
- `CTX_TIMELINE_EVENT_HASH_MISMATCH`
- `CTX_TIMELINE_ROOT_MISSING`

## Compliance Command

```sh
npm run context -- compliance --json
npm run context -- compliance --source <file> --json
```

Output mode: `context-compliance`

```json
{
  "schemaVersion": 1,
  "mode": "context-compliance",
  "ok": true,
  "scope": {
    "sourceFile": null
  },
  "root": {
    "currentRoot": "sha256:...",
    "currentRootExists": true,
    "rootHashOk": true,
    "parentChainOk": true,
    "rootDepth": 3
  },
  "timeline": {
    "events": 2,
    "eventHashesOk": true,
    "rootReferencesOk": true,
    "missingRoots": 0,
    "hashFailures": 0
  },
  "nodes": {
    "active": 1,
    "superseded": 1,
    "nodeHashesOk": true,
    "lifecycleOk": true
  },
  "anchors": {
    "checked": 1,
    "ok": true
  },
  "indexes": {
    "sourceIndexOk": true
  },
  "diagnostics": []
}
```

## Compliance Checks

Root checks:

- `root.json` exists and has a current root.
- Current root snapshot exists.
- Root snapshot hash matches canonical payload.
- Parent root chain resolves to the initial root.

Timeline checks:

- event files parse
- event hashes verify
- events reference existing previous and current roots

Node checks:

- active node files exist
- active node hashes verify
- active nodes are not marked superseded or archived
- superseded nodes remain addressable
- archived nodes remain addressable through roots

Anchor checks:

- source file exists
- source hash matches current bytes
- source anchor range extracts valid text
- exact-text preconditions match extracted text

Index checks:

- source index exists
- source index points to active source-anchored nodes
- source index does not point to superseded or archived nodes
- active source-anchored nodes are indexed

## Source Scope

`--source <file>` restricts event review and anchor checks to that file where practical. Root integrity remains global because source-scoped compliance depends on a trustworthy current root.

## Compliance Diagnostics

Root:

- `CTX_COMPLIANCE_ROOT_MISSING`
- `CTX_COMPLIANCE_ROOT_POINTER_MALFORMED`
- `CTX_COMPLIANCE_ROOT_SNAPSHOT_MISSING`
- `CTX_COMPLIANCE_ROOT_HASH_MISMATCH`
- `CTX_COMPLIANCE_PARENT_ROOT_MISSING`
- `CTX_COMPLIANCE_PARENT_CHAIN_BROKEN`

Events:

- `CTX_COMPLIANCE_EVENT_HASH_MISMATCH`
- `CTX_COMPLIANCE_EVENT_ROOT_MISSING`
- `CTX_COMPLIANCE_EVENT_MALFORMED`

Nodes:

- `CTX_COMPLIANCE_NODE_MISSING`
- `CTX_COMPLIANCE_NODE_HASH_MISMATCH`
- `CTX_COMPLIANCE_ACTIVE_NODE_SUPERSEDED`
- `CTX_COMPLIANCE_SUPERSEDED_NODE_ACTIVE`
- `CTX_COMPLIANCE_SUPERSEDED_NODE_MISSING`

Indexes:

- `CTX_COMPLIANCE_SOURCE_INDEX_MISSING`
- `CTX_COMPLIANCE_SOURCE_INDEX_STALE`
- `CTX_COMPLIANCE_SOURCE_INDEX_POINTS_TO_SUPERSEDED`

Anchors:

- `CTX_SOURCE_MISSING`
- `CTX_ANCHOR_RANGE_INVALID`
- `CTX_PRECONDITION_MISMATCH`
- `CTX_SOURCE_HASH_MISMATCH`

## Policy Command

```sh
npm run context -- policy --json
npm run context -- policy --policy verified --json
npm run context -- policy --policy strict --source <file> --json
```

Output mode: `context-policy`

```json
{
  "schemaVersion": 1,
  "mode": "context-policy",
  "policy": {
    "mode": "strict",
    "ok": true,
    "status": "strict"
  },
  "compliance": {},
  "diagnostics": []
}
```

## Policy Modes

`advisory`:

- evaluates compliance
- reports diagnostics
- keeps `policy.ok: true` when the command runs
- exits successfully

`verified`:

- requires `compliance.ok === true`
- emits `CTX_POLICY_COMPLIANCE_FAILED` on failure
- exits non-zero on policy failure

`strict`:

- requires `compliance.ok === true`
- requires anchor checks to pass
- requires timeline `hashFailures === 0`
- requires timeline `missingRoots === 0`
- requires lifecycle consistency
- requires source index consistency
- exits non-zero on policy failure

Strict diagnostics:

- `CTX_POLICY_COMPLIANCE_FAILED`
- `CTX_POLICY_STRICT_ANCHOR_FAILED`
- `CTX_POLICY_STRICT_TIMELINE_FAILED`
- `CTX_POLICY_STRICT_LIFECYCLE_FAILED`
- `CTX_POLICY_STRICT_INDEX_FAILED`

## Check Cycle Policy

```sh
npm run context -- check-cycle --source <file> --json --policy advisory
npm run context -- check-cycle --source <file> --json --policy verified
npm run context -- check-cycle --source <file> --json --policy strict
```

Policy-enabled check cycles include:

```json
{
  "policy": {
    "mode": "strict",
    "ok": true
  },
  "compliance": {}
}
```

The check cycle still records an event for the semantic cycle. Policy evaluation happens after capture, projection, verification, and event write.
