# Context-Bearing Compilation

The semantic substrate sidecar models how Zero can carry development context through compilation workflows. The current implementation stores semantic memory locally and verifies it through development-time commands.

## Model

The substrate uses:

- immutable semantic nodes
- immutable root snapshots
- immutable context events
- append-only event timeline
- movable current-root pointer
- development-time compliance checks
- context-root attestation boundary for future artifacts

The current sidecar reads native command output and writes local context state. Native compiler execution remains unchanged.

## Development Cycle

The implemented check cycle is:

```sh
npm run context -- check-cycle --source <file> --json
```

Sequence:

1. read current root
2. capture repair memory from `zero fix --plan --json`
3. project active context for the source
4. verify active context
5. read updated root
6. write a context event
7. optionally evaluate policy

With policy:

```sh
npm run context -- check-cycle --source <file> --json --policy strict
```

This models a future context-aware development loop where semantic memory can be checked before accepting a context-bearing edit.

## Attestation Boundary

A future build artifact can carry:

- source identity
- compiler identity
- context root hash
- context policy mode
- compliance result summary

The sidecar already provides the current root and compliance summary. The native integration boundary is the point where the compiler records or consumes that root.

## Restoring Context

When code returns to development, a saved context root can be used to restore semantic memory:

1. locate the root snapshot
2. verify its parent chain
3. verify referenced node hashes
4. verify event timeline root references
5. rebuild source projection
6. run compliance or policy

The current commands that support this path are:

- `timeline --json`
- `compliance --json`
- `policy --policy verified --json`
- `policy --policy strict --json`
- `diff --from <root> --to <root> --json`

## Runtime Boundary

Runtime execution does not traverse the semantic context graph. Context roots can be attached to artifacts as attestations. Development tools can later verify the root and timeline.

## Native Integration Path

The next native integration points are:

1. expose the current context root to compiler-facing command flows
2. allow native check/fix flows to accept a context policy mode
3. attach context root metadata to build artifacts
4. restore and verify context root metadata when artifacts return to development
5. decide which policy failures affect native command exit codes

## Current Sidecar Capabilities

Capture:

- `capture-fix-plan`
- `capture-check`
- `capture-explain`
- `capture-graph`

Read models:

- `project`
- `events`
- `timeline`
- `diff`

Verification:

- `verify`
- `compliance`
- `policy`

Mutation:

- capture commands
- `check-cycle`
- `reconcile --node <hash> --action archive`
- `reconcile --node <hash> --action refresh-anchor`
- `reconcile --node <hash> --action supersede`

## Implementation Boundary

The sidecar currently depends on existing native JSON outputs:

- `bin/zero fix --plan --json <file>`
- `bin/zero check --json <file>`
- `bin/zero explain --json <diagnosticCode>`
- `bin/zero graph --json <file-or-project>`

Native compiler C files are not modified by the current substrate branch.
