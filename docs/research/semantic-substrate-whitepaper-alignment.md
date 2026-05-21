# Semantic Substrate V1 Whitepaper Alignment

The original Semantic Merkle Substrate v1 whitepaper frames a compiler-mediated system for preserving and projecting code meaning. Research and implementation have evolved since that draft. The sidecar branch implements a concrete local substrate with root history, events, timeline projection, compliance, policy, reconciliation, and generalized capture.

This page maps the v1 whitepaper concepts to the current implementation and identifies the next technical boundaries. It is a bridge between the original research framing and the current sidecar contracts.

For the current implementation-grounded paper, see [Zero Semantic Merkle Substrate](./zero-semantic-merkle-substrate-whitepaper.md).

## Core Thesis

Whitepaper thesis:

```text
Store deep. Project shallow. Expand lazily. Preserve full fidelity.
Compress structurally. Ground everything in code.
```

Sidecar implementation:

- stores context as hash-addressed nodes, roots, and events
- projects active source context through `project`
- verifies anchors, hashes, lifecycle, events, and root lineage
- records repair, diagnostic, explain, and graph context
- keeps old node versions addressable through root snapshots
- exposes compliance and policy commands for development-time checks

Pending native work:

- compiler-owned projection IR
- semantic bytecode and codebook manifests
- residual storage and expansion handles
- source-symbol anchoring beyond path/range
- artifact context-root attestation

## Concept Mapping

| Whitepaper concept | Current sidecar implementation | Next boundary |
| --- | --- | --- |
| Semantic Merkle DAG | Hash-addressed nodes plus root snapshots and parent links | Rich relation graph and semantic bytecode nodes |
| Active semantic frontier | `project --source <file> --json` active nodes | Compiler-ranked projection by symbol, edit scope, and token budget |
| Source anchor | file path, byte range, source hash, exact-text precondition | symbol path, AST identity, signature/body hash, movement recovery |
| Semantic reconciliation | `reconcile --source`, `archive`, `refresh-anchor`, `supersede` | compiler diagnostics that require explicit context reconciliation |
| Context diagnostics | `CTX_*` diagnostics across verify, timeline, compliance, policy, reconcile | native diagnostics surfaced with Zero command output |
| Repair memory | `repair-memory` nodes from fix-plan JSON | repair lineage tied to source symbols and tests |
| Diagnostic memory | `diagnostic-memory` nodes from check JSON | richer diagnostic relation graph |
| Natural-language residual | `residualSummary`, explain payloads | residual nodes, compressed blobs, expansion policy |
| Semantic bytecode | symbolic `codes[]` and projection frontier | codebook/codec manifests and decodable bytecode |
| Context root | `root.json` current pointer and root snapshots | artifact-attached context root |
| Runtime dormant context | sidecar-only storage and checks | build metadata carrying root attestations |

## Implemented DAG Shape

The sidecar models the DAG through:

- node parent hashes
- lifecycle links: `supersedes`, `supersededBy`
- root parent chain: `parentRoot`
- event root transitions: `previousRoot`, `currentRoot`

This gives the branch semantic lineage without requiring a full relation graph yet.

## Projection Frontier

The current projection command returns active source-linked nodes:

```sh
npm run context -- project --source <file> --json
```

The projection includes:

- node kind
- node id and hash
- lifecycle
- parent hashes
- semantic codes
- diagnostic and repair identifiers
- residual summary
- projection frontier

The whitepaper’s projection IR also includes symbol facts, invariants, residual handles, relation graphs, token budgets, and expansion triggers. Those are native integration targets.

## Semantic Bytecode And Codebooks

The sidecar uses inspectable symbolic fields:

- `codes`
- `diagnosticCode`
- `repairId`
- `projection.frontier.diagnostics`
- `projection.frontier.repairs`
- `projection.frontier.edits`

These fields are the current codebook seed. They support deterministic storage and projection without introducing a frozen ontology.

The next bytecode boundary is:

- versioned codebook manifest
- versioned codec manifest
- canonical semantic expression format
- residual handles
- migration rules for old nodes

## Natural-Language Residuals

The sidecar preserves residual context in:

- `residualSummary`
- `message`
- `help`
- `explain`
- `graph`

This matches the whitepaper’s requirement to preserve natural-language meaning while projecting compact summaries. The current implementation stores residuals inline. A later version can move large residuals into content-addressed residual files or packs.

## Source Anchoring

Current anchors:

```json
{
  "path": "conformance/native/fail/mem-copy-immutable-dst.0",
  "range": {
    "start": { "line": 2, "column": 5 },
    "end": { "line": 2, "column": 8 },
    "columnUnit": "utf8-byte"
  },
  "sourceHash": "sha256:...",
  "status": "active"
}
```

Current recovery:

- exact-text precondition verification
- unique exact-text relocation through `reconcile --action refresh-anchor`

Next anchoring boundary:

- symbol path
- AST node kind
- normalized AST hash
- signature hash
- body hash
- related tests
- diagnostic links

## Compliance As Development-Time Context Check

The whitepaper describes compiler-mediated context verification. The sidecar implements the development-time check as:

```sh
npm run context -- compliance --json
npm run context -- policy --policy strict --json
```

Strict policy requires:

- compliant root state
- intact timeline
- active anchor verification
- lifecycle consistency
- source index consistency

This gives the branch an enforceable local contract before native compiler integration.

## Reconciliation Loop

Whitepaper loop:

```text
edit
  ↓
detect drift
  ↓
reconcile code or context
  ↓
new context root
```

Sidecar loop:

```sh
npm run context -- reconcile --source <file> --json
npm run context -- reconcile --node <hash> --action refresh-anchor --json
npm run context -- reconcile --node <hash> --action supersede --summary <text> --json
```

Reconciliation creates new node versions, advances root history, rebuilds source index, and records `context-reconcile` events.

## Runtime Dormancy And Attestation

The whitepaper’s runtime boundary is implemented as sidecar isolation today:

- context lives under `.zero/context`
- commands run during development
- native runtime artifacts do not depend on context traversal

The next artifact boundary is context-root attestation:

- current root hash
- policy mode
- compliance summary
- compiler version
- source identity

## Gaps To Track

Future implementation boundaries:

- native `zero context` command family
- compiler-owned source-symbol resolver
- semantic bytecode codec
- codebook promotion flow
- residual pack storage
- projection token budgets
- invariant coverage checks
- artifact-attached context root metadata
- fork import/export flows
