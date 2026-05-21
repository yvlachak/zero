# Semantic Substrate Command Surface

The sidecar command entrypoint is:

```sh
npm run context -- <command> [options]
```

The direct command is:

```sh
node --experimental-strip-types scripts/semantic-context.mts <command> [options]
```

## Command Matrix

| Command | Mutates context | Purpose |
| --- | --- | --- |
| `init` | yes | Create storage layout, source index, root pointer, and initial root snapshot. |
| `capture-repair` | yes | Capture the TYP009 repair fixture as `repair-memory`. |
| `capture-fix-plan` | yes | Capture repair memory from `zero fix --plan --json`. |
| `capture-check` | yes | Capture diagnostics from `zero check --json`. |
| `capture-explain` | yes | Capture diagnostic explanation payloads. |
| `capture-graph` | yes | Capture graph command output as source-linked context. |
| `project` | no | Project active source context. |
| `verify` | no | Verify active nodes, anchors, root hash, and index references. |
| `diff` | no | Compare context roots or root snapshots. |
| `events` | no | List stored context events. |
| `timeline` | no | Project the event timeline with event/root verification metadata. |
| `compliance` | no | Verify root, timeline, node, anchor, lifecycle, and index compliance. |
| `policy` | no | Interpret compliance under advisory, verified, or strict modes. |
| `reconcile` | mixed | Report drift actions or apply explicit reconciliation actions. |
| `check-cycle` | yes | Run capture, project, verify, event write, and optional policy. |

## Initialization

```sh
npm run context -- init
```

Output mode: `context-init`

Creates:

- `.zero/context/nodes`
- `.zero/context/roots`
- `.zero/context/events`
- `.zero/context/indexes`
- `.zero/context/indexes/source-index.json`
- `.zero/context/root.json`
- initial root snapshot

## Capture Commands

### `capture-fix-plan`

```sh
npm run context -- capture-fix-plan --source conformance/native/fail/mem-copy-immutable-dst.0
npm run context -- capture-fix-plan --source <file> --fix-plan-json <path>
```

Output mode: `context-capture-fix-plan`

Reads fix-plan JSON and creates `repair-memory` nodes for preview-bearing fixes. No-preview fixes are skipped with structured output.

### `capture-check`

```sh
npm run context -- capture-check --source <file> --json
```

Output mode: `context-capture-check`

Runs:

```sh
bin/zero check --json <file>
```

Creates `diagnostic-memory` nodes from diagnostics.

### `capture-explain`

```sh
npm run context -- capture-explain --code TYP009 --json
```

Output mode: `context-capture-explain`

Runs:

```sh
bin/zero explain --json TYP009
```

Creates an `explain-residual` node keyed by diagnostic code.

### `capture-graph`

```sh
npm run context -- capture-graph --source <file-or-project> --json
```

Output mode: `context-capture-graph`

Runs:

```sh
bin/zero graph --json <file-or-project>
```

Creates a `graph-context` node linked to the source input.

## Projection

```sh
npm run context -- project --source <file> --json
npm run context -- project --source <file> --json --include-superseded
```

Output mode: `context-project`

Default projection returns active nodes indexed to the source. `--include-superseded` also includes superseded source-anchored nodes.

Archived nodes are addressable by hash and omitted from source projection.

## Verification

```sh
npm run context -- verify --json
npm run context -- verify --json --include-superseded
```

Output mode: `context-verify`

Verifies active nodes by default. With `--include-superseded`, it also checks superseded and archived nodes referenced by the current root.

## Diff

```sh
npm run context -- diff --from <context-dir-or-root-snapshot> --to <context-dir-or-root-snapshot> --json
```

Output mode: `context-diff`

Accepts context directories, root snapshot paths, or root hashes in the active context directory.

Reports:

- added nodes
- removed nodes
- changed nodes
- unchanged nodes
- lifecycle changes

## Events

```sh
npm run context -- events --json
```

Output mode: `context-events`

Lists stored events and verifies event hashes while reading.

## Timeline

```sh
npm run context -- timeline --json
npm run context -- timeline --source <file> --json
```

Output mode: `context-timeline`

Projects event history. Source-scoped mode filters events by `sourceFile`.

Timeline entries include:

- `eventId`
- `eventHash`
- `eventHashOk`
- `previousRootExists`
- `currentRootExists`
- captured summaries
- skipped summaries
- verification summary

## Compliance

```sh
npm run context -- compliance --json
npm run context -- compliance --source <file> --json
```

Output mode: `context-compliance`

Read-only compliance verification. Source-scoped mode restricts source event and anchor review while still verifying global root integrity.

## Policy

```sh
npm run context -- policy --json
npm run context -- policy --policy verified --json
npm run context -- policy --policy strict --source <file> --json
```

Output mode: `context-policy`

Policy modes:

- `advisory`
- `verified`
- `strict`

Advisory reports compliance diagnostics and keeps policy success. Verified and strict fail when their requirements are not met.

## Check Cycle

```sh
npm run context -- check-cycle --source <file> --json
npm run context -- check-cycle --source <file> --json --policy strict
```

Output mode: `context-check-cycle`

Sequence:

1. read previous root
2. run capture-fix-plan equivalent
3. project active source context
4. verify active context
5. write context event
6. optionally evaluate policy

Repeated unchanged cycles still write an event with `rootChanged: false`.

## Reconciliation

```sh
npm run context -- reconcile --source <file> --json
npm run context -- reconcile --node <hash> --action archive --json
npm run context -- reconcile --node <hash> --action refresh-anchor --json
npm run context -- reconcile --node <hash> --action supersede --summary <text> --json
```

Output mode: `context-reconcile`

Source mode is read-only and reports candidate actions. Node action mode mutates context and records a reconcile event.

## Exit Behavior

- Commands that report hard diagnostics set a non-zero exit code.
- `policy --policy advisory` exits successfully when the command runs, even if compliance diagnostics are present.
- `policy --policy verified` and `policy --policy strict` fail when policy requirements fail.
- `check-cycle --policy advisory` keeps advisory policy success while preserving diagnostics in output.
