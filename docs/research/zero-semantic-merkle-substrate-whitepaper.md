# Zero Semantic Merkle Substrate

## Current Technical Whitepaper

Status: research branch architecture document
Reference branch: `yanni/semantic-substrate-lab`
Source of truth: `scripts/semantic-context.mts`, `scripts/semantic-context-smoke.mts`, package command scripts, and the research docs in this directory
Native compiler status: no native compiler integration in this branch

This paper updates the original Semantic Merkle Substrate thesis against the current sidecar implementation. Earlier whitepaper drafts are useful framing material. The branch now defines more precise contracts through working code: generated context storage, content hashes, source anchors, root snapshots, event records, timelines, compliance, policy modes, reconciliation, and generalized capture from existing Zero command output.

## 1. Thesis

Zero should be able to preserve development-time meaning as a first-class artifact. Source text records executable intent. Compiler diagnostics record judgment. Fix plans record repair opportunities. Explain output records rationale. Graph output records structural facts. Development cycles record the path by which context evolved.

The Semantic Merkle Substrate stores those facts as hash-addressed semantic memory. It gives a future agent or developer more than a file tree and commit history. It gives them a current semantic frontier, root lineage, event timeline, verification result, and reconciliation state.

The current branch implements this as a local sidecar. The sidecar consumes existing `bin/zero` JSON outputs and writes generated state under `.zero/context`. The native compiler continues to execute normally. The substrate operates in the development plane, where context can be captured, projected, verified, diffed, reconciled, and checked by policy.

The long-term model is context-bearing compilation:

```text
Zero command output
  -> semantic nodes
  -> context roots
  -> context events
  -> timeline projection
  -> compliance and policy
  -> development-time context checks
  -> optional artifact attestation
```

Runtime artifacts do not need to traverse the context graph to execute code. Build artifacts can later carry a context-root attestation. When code returns to development, tools can restore or verify the context root, replay the timeline, project active memory, and enforce policy.

## 2. Current Implementation

The sidecar entrypoint is:

```sh
node --experimental-strip-types scripts/semantic-context.mts <command> [options]
```

The package scripts expose the same surface through:

```sh
npm run context -- <command> [options]
```

The implementation currently supports:

- `init`
- `capture-repair`
- `capture-fix-plan`
- `capture-check`
- `capture-explain`
- `capture-graph`
- `project`
- `verify`
- `diff`
- `check-cycle`
- `events`
- `timeline`
- `compliance`
- `policy`
- `reconcile`

The sidecar storage is generated local state:

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

Tests use `ZERO_CONTEXT_DIR` to isolate context state in temporary directories. The default `.zero/context` directory remains ignored by Git.

## 3. Semantic Nodes

A semantic node is one unit of context memory. The current node kinds are:

- `repair-memory`
- `diagnostic-memory`
- `explain-residual`
- `graph-context`

Each node has:

- `schemaVersion`
- `kind`
- `nodeId`
- optional source anchor
- semantic codes
- residual or structured payload fields
- projection frontier
- parent hashes
- lifecycle metadata
- content hash

The `nodeId` is the stable conceptual identity. The hash is the content identity. Repeated capture of the same concept can produce one of three outcomes:

- `added`: no active node with the same `nodeId` exists
- `unchanged`: the active node has the same computed content hash
- `superseded`: the `nodeId` matches but the content hash changes

When a node is superseded, the new node becomes active, records the old hash in `parents` and `lifecycle.supersedes`, and the old node records `lifecycle.supersededBy`.

Current lifecycle states are:

- `active`
- `superseded`
- `archived`

The implementation hashes semantic node payloads with lifecycle excluded. This is an intentional current contract in `nodeHash`: lifecycle state is root-owned mutable metadata, while the semantic payload hash remains stable across active, superseded, and archived state changes. Compliance verifies that lifecycle state and root membership agree.

That split is useful for the sidecar because archiving or superseding a node can update lifecycle state without changing the node's semantic content hash. A stricter future storage model can move lifecycle edges into separate immutable records, but the current branch treats node content identity and lifecycle state as two linked layers.

## 4. Source Anchors

Source anchors bind context to code. Current anchors use:

- source path
- source range
- `utf8-byte` column unit
- source hash
- active status
- exact-text preconditions in projection edits

Verification checks:

- the source file exists
- the source file hash matches the stored `sourceHash`
- the anchor range can be extracted
- exact-text preconditions match the anchored text

These checks ground semantic memory in source bytes. They keep repair memories, diagnostics, and graph facts from becoming free-floating annotations.

The current recovery mechanism is explicit reconciliation. `reconcile --source <file> --json` reports candidates when source anchors fail. `reconcile --node <hash> --action refresh-anchor --json` can relocate an exact-text precondition when it appears exactly once in the same file.

Future native integration should extend anchors from path/range to compiler-owned symbol identities, AST node kinds, normalized AST hashes, signature hashes, and package graph positions.

## 5. Roots

A root snapshot captures a semantic memory state. The movable pointer is `.zero/context/root.json`:

```json
{
  "schemaVersion": 1,
  "currentRoot": "sha256:<current-root>",
  "previousRoot": "sha256:<previous-root>",
  "rootPath": ".zero/context/roots/<current-root>.json",
  "indexes": {
    "sourceIndex": ".zero/context/indexes/source-index.json"
  }
}
```

Each root snapshot lives at `.zero/context/roots/<root-hash>.json`:

```json
{
  "schemaVersion": 1,
  "contextRoot": "sha256:<root>",
  "parentRoot": "sha256:<parent-root>",
  "reason": "capture-fix-plan",
  "activeNodes": ["sha256:<active-node>"],
  "supersededNodes": ["sha256:<superseded-node>"],
  "archivedNodes": ["sha256:<archived-node>"],
  "nodes": ["sha256:<active-node>"],
  "createdAt": null,
  "indexes": {
    "sourceIndex": ".zero/context/indexes/source-index.json"
  }
}
```

Root snapshots are content-addressed with canonical JSON. The pointer can move. The snapshots form root lineage through `parentRoot`.

Mutating commands advance the root when context state changes. Unchanged repeated capture does not create a new root snapshot. A repeated check cycle can still create an event with `rootChanged: false`, because the development cycle occurred even though the context root stayed fixed.

## 6. Events

Events record why the context changed or why a cycle occurred. Current event modes are:

- `context-check-cycle`
- `context-reconcile`

Event files live under `.zero/context/events/<event-hash>.json`:

```json
{
  "schemaVersion": 1,
  "kind": "context-event",
  "eventId": "ctx:event:000001",
  "eventHash": "sha256:<event-hash>",
  "mode": "context-check-cycle",
  "sourceFile": "conformance/native/fail/mem-copy-immutable-dst.0",
  "previousRoot": "sha256:<previous-root>",
  "currentRoot": "sha256:<current-root>",
  "rootChanged": true,
  "captured": [
    {
      "nodeId": "ctx:repair-memory:typ009:make-binding-mutable",
      "hash": "sha256:<node-hash>",
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

Event hashes are computed over canonical JSON with `eventHash` excluded. Event IDs are stable sequence identifiers in the current event directory. Timeline and compliance commands verify event hashes while reading.

Events explain root transitions. Roots define state. Nodes define semantic memory. The timeline projects the event sequence into an audit-friendly read model.

## 7. Capture

The substrate began as a repair-memory capture path for `TYP009` and `make-binding-mutable`. The current branch generalizes capture across multiple Zero command surfaces.

### 7.1 Fix Plan Capture

`capture-fix-plan` runs or reads:

```sh
bin/zero fix --plan --json <file>
```

Preview-bearing fixes become `repair-memory` nodes. Fixes without preview are skipped with structured output. Malformed fix-plan JSON emits diagnostics.

Repair nodes include:

- diagnostic code
- repair ID
- safety
- summary
- source anchor from edit path/range
- source hash when readable
- semantic codes such as `DIAGNOSTIC_REPAIR`
- derived diagnostic code such as `MUTABLE_BINDING_REQUIRED`
- `BEHAVIOR_PRESERVING_EDIT` when applicable
- projection edits with old text, new text, and exact-text preconditions

### 7.2 Check Capture

`capture-check` runs:

```sh
bin/zero check --json <file>
```

It creates `diagnostic-memory` nodes from compiler diagnostics. These nodes let the substrate remember diagnostic facts separately from repair plans.

### 7.3 Explain Capture

`capture-explain` runs:

```sh
bin/zero explain --json <diagnosticCode>
```

It creates `explain-residual` nodes. These preserve compiler-authored diagnostic rationale and repair descriptions as reusable context.

### 7.4 Graph Capture

`capture-graph` runs:

```sh
bin/zero graph --json <file-or-project>
```

It creates `graph-context` nodes. The current graph node is intentionally broad: it stores command output as source-linked context and gives later native work a stable place to refine graph facts.

## 8. Projection, Diff, and Timeline

`project` returns active context for a source by default:

```sh
npm run context -- project --source <file> --json
```

`--include-superseded` includes superseded source-anchored nodes. Archived nodes remain addressable by hash but are omitted from source projection.

`diff` compares context directories, root snapshot paths, or root hashes:

```sh
npm run context -- diff --from <root-or-context> --to <root-or-context> --json
```

It reports added, removed, changed, unchanged, and lifecycle-changed nodes.

`timeline` reads events and checks root references:

```sh
npm run context -- timeline --json
npm run context -- timeline --source <file> --json
```

Timeline entries include event hash verification, previous/current root existence, captured summaries, skipped summaries, verification summaries, and aggregate counts:

- `summary.events`
- `summary.rootTransitions`
- `summary.hashFailures`
- `summary.missingRoots`

Timeline is the read model that turns event files and root snapshots into a development history.

## 9. Check Cycle

`check-cycle` models the future context-bearing development loop:

```sh
npm run context -- check-cycle --source <file> --json
npm run context -- check-cycle --source <file> --json --policy strict
```

The command:

1. reads the previous root
2. runs the equivalent of `capture-fix-plan`
3. projects active context for the source
4. verifies active context
5. reads the current root
6. records a context event
7. evaluates policy when requested
8. emits one JSON packet

The output includes:

- source file
- root transition
- capture summaries
- projection
- verification
- event path and hash
- optional compliance and policy
- diagnostics

Repeated unchanged cycles write another event with `rootChanged: false`. That preserves the fact that a development cycle occurred without falsely advancing the root lineage.

## 10. Compliance

Compliance is the development-time trust check:

```sh
npm run context -- compliance --json
npm run context -- compliance --source <file> --json
```

It verifies:

- root pointer exists
- current root snapshot exists
- root snapshot hash matches canonical payload
- parent root chain is valid
- event hashes are valid
- events reference existing roots
- active nodes exist
- active node hashes match canonical payloads
- active node lifecycle state agrees with root membership
- superseded nodes remain addressable
- source anchors verify
- source index points to active source-anchored nodes
- source index does not point to superseded or missing nodes

Source-scoped compliance filters source event and anchor review while still verifying enough global root state to trust the scoped answer.

The compliance command returns a structured summary:

```json
{
  "schemaVersion": 1,
  "mode": "context-compliance",
  "ok": true,
  "scope": {
    "sourceFile": null
  },
  "root": {
    "currentRoot": "sha256:<root>",
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

Compliance diagnostics cover malformed roots, missing snapshots, parent chain failures, event hash mismatches, missing event roots, node hash mismatches, lifecycle inconsistencies, source anchor failures, and stale source index entries.

## 11. Policy

Policy interprets compliance:

```sh
npm run context -- policy --json
npm run context -- policy --policy verified --json
npm run context -- policy --policy strict --source <file> --json
```

Modes:

- `advisory`: reports compliance diagnostics and keeps policy success when the command runs
- `verified`: requires `compliance.ok`
- `strict`: requires compliance plus anchor, timeline, lifecycle, and source index integrity

Policy output embeds the full compliance result:

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

`check-cycle --policy <mode>` embeds policy and compliance into the cycle result. This gives a single command that captures, projects, verifies, records an event, and reports whether the resulting context state satisfies the selected development policy.

## 12. Reconciliation

Verification and compliance detect drift. Reconciliation creates explicit semantic state transitions.

Read-only source reconciliation:

```sh
npm run context -- reconcile --source <file> --json
```

Mutating node actions:

```sh
npm run context -- reconcile --node <hash> --action archive --json
npm run context -- reconcile --node <hash> --action refresh-anchor --json
npm run context -- reconcile --node <hash> --action supersede --summary <text> --json
```

`archive` moves an active node out of active projection, marks it archived, updates root state, rebuilds source index, and records a `context-reconcile` event.

`refresh-anchor` searches for the exact precondition text in the same file. If it appears exactly once, the command writes a new active node version with the new range, supersedes the old node, advances the root, rebuilds source index, and records an event.

`supersede` creates a new active node version with an updated summary or semantic payload, supersedes the old node, advances the root, rebuilds source index, and records an event.

Reconciliation keeps semantic memory maintainable as source changes. It also creates the natural native boundary for CTX diagnostics such as stale source index, anchor mismatch, and reconciliation required.

## 13. Integrity Model

The substrate uses SHA-256 over canonical JSON. Current rules:

- object keys are sorted
- array order is preserved
- `undefined` fields are omitted
- node hashes exclude `hash` and lifecycle metadata
- event hashes exclude `eventHash`
- root hashes cover the root snapshot payload without `contextRoot`
- source hashes are computed from current file bytes

Integrity is checked by:

- `verify`
- `events`
- `timeline`
- `compliance`
- `policy`
- `diff`

The important implementation distinction is that node content hashes identify semantic payload, while root membership and lifecycle metadata identify current state. This lets the sidecar preserve semantic content identity across state transitions. Native work can decide whether lifecycle state remains node-local metadata or becomes a separate immutable edge record.

## 14. Current Invariants

The current branch enforces or tests these invariants:

- `.zero/context/root.json` points at the current root snapshot.
- Root snapshots form a parent chain.
- Root snapshot hashes match canonical payloads.
- Active nodes listed by the current root exist.
- Active node hashes match canonical payloads.
- Superseded and archived nodes remain addressable.
- Active root entries are not marked superseded or archived.
- Superseded root entries are not marked active.
- Source index entries point to active source-anchored nodes.
- Timeline event hashes verify.
- Event previous/current roots exist for compliant contexts.
- Active source anchors verify against source bytes.
- Exact-text preconditions match anchored text.
- Mutating reconciliation actions advance root history and record events.
- Repeated unchanged check cycles record events without advancing root history.

These invariants are covered by `scripts/semantic-context-smoke.mts` and repository validation commands.

## 15. Drift From Earlier Drafts

The early whitepaper framed an ideal immutable Semantic Merkle DAG. The sidecar implements a practical pre-native version with some deliberate differences:

- Lifecycle state is stored on node files and excluded from node content hashes. This gives stable semantic payload identity while allowing state transitions.
- The relation graph is represented by parent hashes, lifecycle links, root parent links, source index, and event transitions. A separate rich relation graph is a future storage layer.
- Semantic bytecode is represented by symbolic `codes[]`, diagnostic codes, repair IDs, and projection frontier fields. Codec and codebook manifests are future storage layers.
- Natural-language residuals are inline fields such as `residualSummary`, diagnostic messages, explain payloads, and graph payloads. Residual pack storage is a future storage layer.
- Source anchoring is path/range/hash/precondition based. Compiler-owned symbol anchors are a future native layer.
- Generated context is local and ignored by Git. Forkable context import/export and artifact attestation are future boundaries.
- Native compiler behavior is unchanged. The branch consumes native JSON output through the sidecar. Native `zero context` commands are a future integration layer.

These differences identify the next architectural boundaries.

## 16. Native Integration Plan

Native integration should proceed in stages from a fresh native-focused branch. The sidecar should remain the reference implementation until native commands absorb stable contracts.

### 16.1 Native Status

First command:

```sh
zero context status --json
```

Responsibilities:

- detect `.zero/context`
- read `root.json`
- report current root pointer
- report source index path
- emit a versioned JSON envelope
- cover missing or malformed storage with command-contract tests

### 16.2 Native Project

Next command:

```sh
zero context project --source <file> --json
```

Responsibilities:

- read current root
- read source index
- read active node files
- filter by source
- emit a projection compatible with the sidecar

### 16.3 Native Verify

Next command:

```sh
zero context verify --json
```

Responsibilities:

- verify active node hashes
- verify source anchors
- verify exact-text preconditions
- emit CTX diagnostics through Zero's structured diagnostic conventions

### 16.4 Native Compliance

Next command:

```sh
zero context compliance --json
```

Responsibilities:

- verify root pointer
- verify current root snapshot and parent chain
- verify event hashes and root references
- verify active and superseded node state
- verify source index consistency
- emit compliance summary compatible with the sidecar

### 16.5 Context-Aware Check

Development command:

```sh
zero check --context <file>
zero check --context-strict <file>
```

Responsibilities:

- load current context root
- project source context
- verify anchors
- run normal check
- emit CTX diagnostics for stale or invalid context
- make strict mode fail on policy violations

### 16.6 Context-Aware Fix

Development command:

```sh
zero fix --context --plan --json <file>
```

Responsibilities:

- emit fix-plan JSON
- optionally emit semantic capture fields
- preserve existing fix-plan contracts while adding context-bearing metadata under explicit flags

### 16.7 Artifact Attestation

Build boundary:

```sh
zero build --context-attest
```

Responsibilities:

- record source identity
- record compiler identity
- record context root
- record policy mode or compliance summary
- keep runtime execution independent from context traversal

## 17. Future Storage Boundaries

The current sidecar is sufficient for local research and native command planning. Further storage work should be driven by native needs:

- move lifecycle transitions into immutable lifecycle event or edge records
- add relation nodes for semantic links beyond parent/supersede
- introduce source-symbol anchors
- add residual packs for large natural-language payloads
- introduce codebook manifests and semantic bytecode codecs
- add context import/export commands for fork transfer
- add artifact attestation files
- add package-level context roots
- add context garbage collection with preservation policies

The next storage change with the highest leverage is a symbol-aware anchor model. It would make reconciliation more precise and reduce dependence on exact text relocation.

## 18. Development Workflow

A current local workflow:

```sh
npm run context -- init
npm run context -- check-cycle --source conformance/native/fail/mem-copy-immutable-dst.0 --json --policy strict
npm run context -- timeline --source conformance/native/fail/mem-copy-immutable-dst.0 --json
npm run context -- compliance --json
npm run context -- reconcile --source conformance/native/fail/mem-copy-immutable-dst.0 --json
```

A future native workflow:

```sh
zero context status --json
zero check --context-strict conformance/native/fail/mem-copy-immutable-dst.0
zero context timeline --source conformance/native/fail/mem-copy-immutable-dst.0 --json
zero context reconcile --source conformance/native/fail/mem-copy-immutable-dst.0 --json
```

The current sidecar proves the mechanics before those commands become native Zero behavior.

## 19. Validation

The branch validates the sidecar through:

```sh
npm run context:test
npm run command-contracts:local
npm run conformance:local
git diff --check
```

The smoke suite covers:

- initialization
- capture from fix-plan
- no-preview skips
- malformed fix-plan diagnostics
- capture-repair equivalence
- source anchor verification
- diffing
- lifecycle transitions
- root history
- check-cycle
- event recording
- timeline projection
- compliance verification
- policy modes
- reconciliation
- generalized capture
- command usage

The substrate remains sidecar-local. Native compiler files are unchanged by this research branch.

## 20. Final Position

The Zero Semantic Merkle Substrate is a development-time memory layer for context-bearing compilation. It stores semantic facts as content-addressed nodes, groups state through root snapshots, records actions through events, projects history through timelines, verifies trust through compliance, interprets trust through policy, and updates stale memory through reconciliation.

The current branch gives the concept working mechanics. It consumes real Zero command output, writes deterministic context state, validates source anchors, records root transitions, detects tampering, and models strict development-time context checks.

The next architectural step is native command integration. Zero should first learn to read and report context state, then project and verify it, then enforce it through context-aware check modes. Artifact attestation and source-declared context can follow once the native command surface is stable.

The substrate gives Zero a way to carry code-associated meaning across development time. Source files describe behavior. Context roots describe the semantic state around that behavior. Together they form the foundation for agent-first development workflows that can inherit, verify, and evolve meaning instead of repeatedly reconstructing it from text alone.
