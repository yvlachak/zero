#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SourceRange = {
  start: { line: number; column: number };
  end: { line: number; column: number };
  columnUnit: "utf8-byte";
};

type SemanticNode = {
  schemaVersion: 1;
  kind: "repair-memory" | "diagnostic-memory" | "explain-residual" | "graph-context";
  nodeId: string;
  sourceAnchor?: {
    path: string;
    range: SourceRange;
    sourceHash: string | null;
    status: "active";
  };
  codes: string[];
  diagnosticCode?: string;
  repairId?: string;
  severity?: string;
  message?: string;
  expected?: string;
  actual?: string;
  help?: string;
  explain?: JsonValue;
  graph?: JsonValue;
  residualSummary: string;
  projection: {
    kind: "context-projection";
    frontier: {
      diagnostics: string[];
      repairs: string[];
      edits: Array<{
        oldText: string;
        newText: string;
        precondition: { kind: "exact-text"; text: string };
      }>;
    };
  };
  parents: string[];
  lifecycle: {
    state: "active" | "superseded" | "archived";
    supersedes: string[];
    supersededBy: string | null;
  };
  hash: string;
};

type RootReason = "init" | "capture-repair" | "capture-fix-plan" | "capture-check" | "capture-explain" | "capture-graph" | "reconcile" | "manual";

type RootSnapshot = {
  schemaVersion: 1;
  contextRoot: string;
  parentRoot: string | null;
  reason: RootReason;
  activeNodes: string[];
  supersededNodes: string[];
  archivedNodes: string[];
  nodes: string[];
  createdAt: null;
  indexes: {
    sourceIndex: string;
  };
};

type RootPointer = {
  schemaVersion: 1;
  currentRoot: string;
  previousRoot: string | null;
  rootPath: string;
  indexes: {
    sourceIndex: string;
  };
};

type SourceIndex = {
  schemaVersion: 1;
  sources: Record<string, string[]>;
};

type Diagnostic = {
  code: string;
  severity?: "error" | "warning";
  nodeId?: string;
  message: string;
  path?: string;
  hash?: string;
  expected?: string;
  actual?: string;
};

type NodeVerification = {
  hash: string;
  nodeId: string;
  lifecycle: SemanticNode["lifecycle"];
  sourceAnchor: {
    path: string | null;
    status: string;
    currentSourceHash: string | null;
  };
  preconditions: Array<{
    kind: "exact-text";
    ok: boolean;
    expected: string;
    actual: string | null;
  }>;
};

type NodeSummary = {
  hash: string;
  nodeId: string;
  kind: string;
  lifecycle: SemanticNode["lifecycle"];
};

type NodeChange = {
  path: string;
  from: JsonValue;
  to: JsonValue;
};

type LoadedContext = {
  input: string;
  contextDir: string;
  rootPath: string;
  nodesDir: string;
  root: RootSnapshot | null;
  nodesById: Map<string, SemanticNode>;
  nodesByHash: Map<string, SemanticNode>;
  diagnostics: Diagnostic[];
};

type FixPlanEdit = {
  path: string;
  range: SourceRange;
  oldText: string;
  newText: string;
  precondition: { kind: "exact-text"; text: string };
};

type CapturedFixPlanNode = {
  nodeId: string;
  hash: string;
  action: "added" | "unchanged" | "superseded";
  diagnosticCode: string;
  repairId: string;
  sourceAnchor: {
    path: string;
    range: SourceRange;
  };
};

type StoreResult = {
  action: "added" | "unchanged" | "superseded";
  node: SemanticNode;
  supersededHash: string | null;
};

type SkippedFixPlanNode = {
  diagnosticCode: string | null;
  repairId: string | null;
  reason: string;
  message: string;
};

type ContextEvent = {
  schemaVersion: 1;
  kind: "context-event";
  eventId: string;
  eventHash: string;
  mode: "context-check-cycle" | "context-reconcile";
  sourceFile: string;
  previousRoot: string;
  currentRoot: string;
  rootChanged: boolean;
  captured: Array<{
    nodeId: string;
    hash: string;
    action: CapturedFixPlanNode["action"] | "archived";
  }>;
  skipped: SkippedFixPlanNode[];
  verification: {
    ok: boolean;
    checkedNodes: number;
  };
  diagnostics: Diagnostic[];
};

type ContextEventSummary = {
  eventHash: string;
  mode: ContextEvent["mode"];
  sourceFile: string;
  previousRoot: string;
  currentRoot: string;
  rootChanged: boolean;
};

type TimelineEvent = {
  eventId: string;
  eventHash: string;
  eventHashOk: boolean;
  mode: ContextEvent["mode"];
  sourceFile: string;
  previousRoot: string;
  previousRootExists: boolean;
  currentRoot: string;
  currentRootExists: boolean;
  rootChanged: boolean;
  captured: ContextEvent["captured"];
  skipped: SkippedFixPlanNode[];
  verification: ContextEvent["verification"];
};

type ComplianceRootState = {
  pointer: RootPointer | null;
  currentRootSnapshot: RootSnapshot | null;
  rootHashOk: boolean;
  parentChainOk: boolean;
  rootDepth: number;
};

type PolicyMode = "advisory" | "verified" | "strict";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
function displayPath(filePath: string) {
  const relative = path.relative(repoRoot, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return filePath.split(path.sep).join("/");
}

let contextDir = "";
let nodesDir = "";
let rootsDir = "";
let eventsDir = "";
let indexesDir = "";
let rootPath = "";
let sourceIndexPath = "";
let contextDisplayPath = "";
let sourceIndexDisplayPath = "";

function configureContextDir(dir = process.env.ZERO_CONTEXT_DIR) {
  contextDir = dir ? path.resolve(repoRoot, dir) : path.join(repoRoot, ".zero/context");
  nodesDir = path.join(contextDir, "nodes");
  rootsDir = path.join(contextDir, "roots");
  eventsDir = path.join(contextDir, "events");
  indexesDir = path.join(contextDir, "indexes");
  rootPath = path.join(contextDir, "root.json");
  sourceIndexPath = path.join(indexesDir, "source-index.json");
  contextDisplayPath = displayPath(contextDir);
  sourceIndexDisplayPath = displayPath(sourceIndexPath);
}

configureContextDir();

function usage(): never {
  console.error(`Usage:
  semantic-context init
  semantic-context capture-repair --source <file>
  semantic-context capture-fix-plan --source <file> [--fix-plan-json <path>]
  semantic-context capture-check --source <file> --json
  semantic-context capture-explain --code <diagnosticCode> --json
  semantic-context capture-graph --source <file-or-project> --json
  semantic-context project --source <file> --json [--include-superseded]
  semantic-context verify --json [--include-superseded]
  semantic-context check-cycle --source <file> --json
  semantic-context events --json
  semantic-context timeline [--source <file>] --json
  semantic-context compliance [--source <file>] --json
  semantic-context policy [--source <file>] [--policy advisory|verified|strict] --json
  semantic-context reconcile --source <file> --json
  semantic-context reconcile --node <hash> --action archive|refresh-anchor|supersede [--summary <text>] --json
  semantic-context diff --from <context-dir-or-root-snapshot> --to <context-dir-or-root-snapshot> --json`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--include-superseded") {
      options.includeSuperseded = true;
    } else if (arg === "--source") {
      const value = rest[++i];
      if (!value) usage();
      options.source = value;
    } else if (arg === "--code") {
      const value = rest[++i];
      if (!value) usage();
      options.code = value;
    } else if (arg === "--from") {
      const value = rest[++i];
      if (!value) usage();
      options.from = value;
    } else if (arg === "--to") {
      const value = rest[++i];
      if (!value) usage();
      options.to = value;
    } else if (arg === "--fix-plan-json") {
      const value = rest[++i];
      if (!value) usage();
      options.fixPlanJson = value;
    } else if (arg === "--policy") {
      const value = rest[++i];
      if (!value) usage();
      options.policy = value;
    } else if (arg === "--node") {
      const value = rest[++i];
      if (!value) usage();
      options.node = value;
    } else if (arg === "--action") {
      const value = rest[++i];
      if (!value) usage();
      options.action = value;
    } else if (arg === "--summary") {
      const value = rest[++i];
      if (!value) usage();
      options.summary = value;
    } else {
      usage();
    }
  }
  if (!command) usage();
  return { command, options };
}

function ensureLayout() {
  mkdirSync(nodesDir, { recursive: true });
  mkdirSync(rootsDir, { recursive: true });
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(indexesDir, { recursive: true });
  if (!existsSync(sourceIndexPath)) writeJson(sourceIndexPath, { schemaVersion: 1, sources: {} } satisfies SourceIndex);
  if (!existsSync(rootPath)) writeRoot([], [], "init");
}

function repoRelative(inputPath: string) {
  const resolved = path.resolve(repoRoot, inputPath);
  return path.relative(repoRoot, resolved).split(path.sep).join("/");
}

function readText(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function sha256Bytes(bytes: Buffer | string) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Text(text: string) {
  return sha256Bytes(text);
}

function sha256File(relativePath: string) {
  return sha256Bytes(readFileSync(path.join(repoRoot, relativePath)));
}

export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function withoutHash(node: SemanticNode): JsonValue {
  const { hash: _hash, lifecycle: _lifecycle, ...payload } = node;
  return payload as JsonValue;
}

function withoutHashWithLifecycle(node: SemanticNode): JsonValue {
  const { hash: _hash, ...payload } = node;
  return payload as JsonValue;
}

function rootPayload(nodes: string[], supersededNodes: string[], archivedNodes: string[], parentRoot: string | null, reason: RootReason, sourceIndex = sourceIndexDisplayPath): JsonValue {
  return {
    schemaVersion: 1,
    parentRoot,
    reason,
    activeNodes: nodes,
    nodes,
    supersededNodes,
    archivedNodes,
    createdAt: null,
    indexes: {
      sourceIndex,
    },
  };
}

export function rootPayloadForSourceIndex(nodes: string[], sourceIndex: string, supersededNodes: string[] = [], parentRoot: string | null = null, reason: RootReason = "manual", archivedNodes: string[] = []): JsonValue {
  const activeNodes = [...new Set(nodes)].sort();
  const superseded = [...new Set(supersededNodes)].sort();
  const archived = [...new Set(archivedNodes)].sort();
  return rootPayload(activeNodes, superseded, archived, parentRoot, reason, sourceIndex);
}

export function nodeHash(node: SemanticNode) {
  return sha256Text(canonicalize(withoutHash(node)));
}

function rootHash(nodes: string[], supersededNodes: string[], parentRoot: string | null, reason: RootReason, archivedNodes: string[] = []) {
  return sha256Text(canonicalize(rootPayload(nodes, supersededNodes, archivedNodes, parentRoot, reason)));
}

export function rootHashForSourceIndex(nodes: string[], sourceIndex: string, supersededNodes: string[] = [], parentRoot: string | null = null, reason: RootReason = "manual", archivedNodes: string[] = []) {
  return sha256Text(canonicalize(rootPayloadForSourceIndex(nodes, sourceIndex, supersededNodes, parentRoot, reason, archivedNodes)));
}

function writeJson(filePath: string, value: JsonValue) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function activeNodesOf(root: RootSnapshot) {
  return [...new Set(root.activeNodes ?? root.nodes ?? [])].sort();
}

function supersededNodesOf(root: RootSnapshot) {
  return [...new Set(root.supersededNodes ?? [])].sort();
}

function archivedNodesOf(root: RootSnapshot) {
  return [...new Set(root.archivedNodes ?? [])].sort();
}

function allRootNodes(root: RootSnapshot) {
  return [...new Set([...activeNodesOf(root), ...supersededNodesOf(root), ...archivedNodesOf(root)])].sort();
}

function rootSnapshotPath(hash: string) {
  return path.join(rootsDir, `${hash.replace("sha256:", "")}.json`);
}

function readRootPointer() {
  if (!existsSync(rootPath)) return null;
  const value = readJson<RootPointer | RootSnapshot>(rootPath);
  if ("currentRoot" in value) return value as RootPointer;
  return null;
}

function readRootSnapshotByHash(hash: string) {
  return readJson<RootSnapshot>(rootSnapshotPath(hash));
}

function writeRoot(nodes: string[], supersededNodes: string[] = [], reason: RootReason = "manual", archivedNodes: string[] = []) {
  const sortedNodes = [...new Set(nodes)].sort();
  const sortedSupersededNodes = [...new Set(supersededNodes)].sort();
  const sortedArchivedNodes = [...new Set(archivedNodes)].sort();
  const previousRoot = readRootPointer()?.currentRoot ?? (existsSync(rootPath) ? readJson<RootSnapshot>(rootPath).contextRoot ?? null : null);
  const payload = rootPayload(sortedNodes, sortedSupersededNodes, sortedArchivedNodes, previousRoot, reason);
  const contextRoot = sha256Text(canonicalize(payload));
  const snapshot: RootSnapshot = {
    contextRoot,
    ...(payload as Omit<RootSnapshot, "contextRoot">),
  };
  const snapshotPath = rootSnapshotPath(contextRoot);
  writeJson(snapshotPath, snapshot as unknown as JsonValue);
  const pointer: RootPointer = {
    schemaVersion: 1,
    currentRoot: contextRoot,
    previousRoot,
    rootPath: displayPath(snapshotPath),
    indexes: {
      sourceIndex: sourceIndexDisplayPath,
    },
  };
  writeJson(rootPath, pointer as unknown as JsonValue);
  return snapshot;
}

function readRoot() {
  const value = readJson<RootPointer | RootSnapshot>(rootPath);
  if ("currentRoot" in value) return readRootSnapshotByHash(value.currentRoot);
  return value as RootSnapshot;
}

function rootPointerFor(root: RootSnapshot) {
  const pointer = readRootPointer();
  if (pointer) return pointer;
  return {
    schemaVersion: 1,
    currentRoot: root.contextRoot,
    previousRoot: root.parentRoot,
    rootPath: displayPath(rootPath),
    indexes: {
      sourceIndex: sourceIndexDisplayPath,
    },
  } satisfies RootPointer;
}

function readSourceIndex() {
  return readJson<SourceIndex>(sourceIndexPath);
}

function writeSourceIndex(index: SourceIndex) {
  const sources: Record<string, string[]> = {};
  for (const source of Object.keys(index.sources).sort()) sources[source] = [...new Set(index.sources[source])].sort();
  writeJson(sourceIndexPath, { schemaVersion: 1, sources } satisfies SourceIndex as unknown as JsonValue);
}

function nodePath(hash: string) {
  return path.join(nodesDir, `${hash.replace("sha256:", "")}.json`);
}

function eventPath(hash: string) {
  return path.join(eventsDir, `${hash.replace("sha256:", "")}.json`);
}

function eventFilenames() {
  return existsSync(eventsDir) ? readdirSync(eventsDir).filter((item) => item.endsWith(".json")).sort() : [];
}

function activeLifecycle(): SemanticNode["lifecycle"] {
  return {
    state: "active",
    supersedes: [],
    supersededBy: null,
  };
}

function lifecycleOf(node: SemanticNode): SemanticNode["lifecycle"] {
  return node.lifecycle ?? activeLifecycle();
}

function writeNode(node: SemanticNode) {
  writeJson(nodePath(node.hash), node as unknown as JsonValue);
}

function readNode(hash: string) {
  return readJson<SemanticNode>(nodePath(hash));
}

function withoutEventHash(event: ContextEvent): JsonValue {
  const { eventHash: _eventHash, ...payload } = event;
  return payload as unknown as JsonValue;
}

export function contextEventHash(event: ContextEvent) {
  return sha256Text(canonicalize(withoutEventHash(event)));
}

function nextEventId() {
  return `ctx:event:${String(eventFilenames().length + 1).padStart(6, "0")}`;
}

function writeContextEvent(input: Omit<ContextEvent, "eventId" | "eventHash">) {
  const eventId = nextEventId();
  const event: ContextEvent = {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    eventId,
    eventHash: "",
    mode: input.mode,
    sourceFile: input.sourceFile,
    previousRoot: input.previousRoot,
    currentRoot: input.currentRoot,
    rootChanged: input.rootChanged,
    captured: input.captured,
    skipped: input.skipped,
    verification: input.verification,
    diagnostics: input.diagnostics,
  };
  event.eventHash = contextEventHash(event);
  writeJson(eventPath(event.eventHash), event as unknown as JsonValue);
  return event;
}

function rebuildSourceIndex(activeHashes: string[]) {
  const sources: Record<string, string[]> = {};
  for (const hash of activeHashes) {
    const filePath = nodePath(hash);
    if (!existsSync(filePath)) continue;
    const node = readJson<SemanticNode>(filePath);
    if (!node.sourceAnchor) continue;
    const sourcePath = node.sourceAnchor.path;
    sources[sourcePath] = [...(sources[sourcePath] ?? []), hash];
  }
  writeSourceIndex({ schemaVersion: 1, sources });
}

function findMakeBindingMutableAnchor(source: string): SourceRange | null {
  const lines = source.split(/\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const letIndex = line.indexOf("let ");
    if (letIndex >= 0 && !line.includes("let mut ") && line.includes("[")) {
      return {
        start: { line: index + 1, column: letIndex + 1 },
        end: { line: index + 1, column: letIndex + 4 },
        columnUnit: "utf8-byte",
      };
    }
  }
  return null;
}

function extractRangeText(source: string, range: SourceRange): { ok: true; text: string } | { ok: false; actual: string } {
  if (range.columnUnit !== "utf8-byte") return { ok: false, actual: "unsupported columnUnit" };
  if (range.start.line !== range.end.line) return { ok: false, actual: "multi-line range" };
  if (range.start.line < 1 || range.start.column < 1 || range.end.column < range.start.column) return { ok: false, actual: "invalid range coordinates" };
  const lines = source.split(/\n/);
  const line = lines[range.start.line - 1];
  if (line === undefined) return { ok: false, actual: "line out of range" };
  const startByte = range.start.column - 1;
  const endByte = range.end.column - 1;
  const lineBytes = Buffer.from(line, "utf8");
  if (startByte > lineBytes.length || endByte > lineBytes.length) return { ok: false, actual: "column out of range" };
  return { ok: true, text: lineBytes.subarray(startByte, endByte).toString("utf8") };
}

function makeTyp009RepairMemoryNode(sourcePath: string): SemanticNode {
  const source = readText(sourcePath);
  const range = findMakeBindingMutableAnchor(source);
  if (!range) {
    throw new Error(`no make-binding-mutable anchor found in ${sourcePath}`);
  }
  const node: SemanticNode = {
    schemaVersion: 1,
    kind: "repair-memory",
    nodeId: "ctx:repair-memory:typ009:make-binding-mutable",
    sourceAnchor: {
      path: sourcePath,
      range,
      sourceHash: sha256Text(source),
      status: "active",
    },
    codes: ["DIAGNOSTIC_REPAIR", "MUTABLE_BINDING_REQUIRED", "BEHAVIOR_PRESERVING_EDIT"],
    diagnosticCode: "TYP009",
    repairId: "make-binding-mutable",
    residualSummary: "An immutable array binding cannot be passed to a mutable span API; make the root binding mutable.",
    projection: {
      kind: "context-projection",
      frontier: {
        diagnostics: ["TYP009"],
        repairs: ["make-binding-mutable"],
        edits: [
          {
            oldText: "let",
            newText: "let mut",
            precondition: { kind: "exact-text", text: "let" },
          },
        ],
      },
    },
    parents: [],
    lifecycle: activeLifecycle(),
    hash: "",
  };
  node.hash = nodeHash(node);
  return node;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function repairNodeId(diagnosticCode: string, repairId: string) {
  return `ctx:repair-memory:${slug(diagnosticCode)}:${slug(repairId)}`;
}

function derivedDiagnosticCode(diagnosticCode: string) {
  const known: Record<string, string> = {
    TYP009: "MUTABLE_BINDING_REQUIRED",
  };
  return known[diagnosticCode] ?? null;
}

function repairCodes(diagnosticCode: string, safety: string) {
  const codes = ["DIAGNOSTIC_REPAIR"];
  const derived = derivedDiagnosticCode(diagnosticCode);
  if (derived) codes.push(derived);
  if (safety === "behavior-preserving") codes.push("BEHAVIOR_PRESERVING_EDIT");
  return codes;
}

function makeRepairMemoryNodeFromFix(sourcePath: string, fix: { diagnosticCode: string; id: string; safety: string; summary: string }, edits: FixPlanEdit[]): SemanticNode {
  const anchor = edits[0];
  const node: SemanticNode = {
    schemaVersion: 1,
    kind: "repair-memory",
    nodeId: repairNodeId(fix.diagnosticCode, fix.id),
    sourceAnchor: {
      path: anchor.path,
      range: anchor.range,
      sourceHash: existsSync(path.join(repoRoot, anchor.path)) ? sha256File(anchor.path) : null,
      status: "active",
    },
    codes: repairCodes(fix.diagnosticCode, fix.safety),
    diagnosticCode: fix.diagnosticCode,
    repairId: fix.id,
    residualSummary: fix.summary,
    projection: {
      kind: "context-projection",
      frontier: {
        diagnostics: [fix.diagnosticCode],
        repairs: [fix.id],
        edits: edits.map((edit) => ({
          oldText: edit.oldText,
          newText: edit.newText,
          precondition: edit.precondition,
        })),
      },
    },
    parents: [],
    lifecycle: activeLifecycle(),
    hash: "",
  };
  node.hash = nodeHash(node);
  return node;
}

function findActiveNodeById(root: RootSnapshot, nodeId: string) {
  for (const hash of activeNodesOf(root)) {
    const filePath = nodePath(hash);
    if (!existsSync(filePath)) continue;
    const node = readJson<SemanticNode>(filePath);
    if (node.nodeId === nodeId) return { hash, node };
  }
  return null;
}

function storeNode(node: SemanticNode, reason: RootReason): StoreResult {
  const root = readRoot();
  let activeNodes = activeNodesOf(root);
  let supersededNodes = supersededNodesOf(root);
  const archivedNodes = archivedNodesOf(root);
  const prior = findActiveNodeById(root, node.nodeId);
  node.lifecycle = activeLifecycle();
  if (!prior) {
    node.parents = [];
    node.hash = nodeHash(node);
    writeNode(node);
    activeNodes = [...activeNodes, node.hash];
    writeRoot(activeNodes, supersededNodes, reason, archivedNodes);
    rebuildSourceIndex(activeNodes);
    return { action: "added", node, supersededHash: null };
  }
  node.parents = prior.node.parents;
  node.hash = nodeHash(node);
  if (prior.hash === node.hash) {
    const activeNode = { ...prior.node, lifecycle: activeLifecycle() };
    writeNode(activeNode);
    rebuildSourceIndex(activeNodes);
    return { action: "unchanged", node: activeNode, supersededHash: null };
  }
  node.parents = [prior.hash];
  node.lifecycle = {
    state: "active",
    supersedes: [prior.hash],
    supersededBy: null,
  };
  node.hash = nodeHash(node);
  const supersededNode = {
    ...prior.node,
    lifecycle: {
      ...lifecycleOf(prior.node),
      state: "superseded" as const,
      supersededBy: node.hash,
    },
  };
  writeNode(supersededNode);
  writeNode(node);
  activeNodes = activeNodes.map((hash) => hash === prior.hash ? node.hash : hash);
  supersededNodes = [...supersededNodes, prior.hash];
  writeRoot(activeNodes, supersededNodes, reason, archivedNodes);
  rebuildSourceIndex(activeNodes);
  return { action: "superseded", node, supersededHash: prior.hash };
}

function commandInit() {
  ensureLayout();
  const root = readRoot();
  const pointer = rootPointerFor(root);
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-init",
    contextRoot: root.contextRoot,
    currentRoot: pointer.currentRoot,
    previousRoot: pointer.previousRoot,
    rootPath: pointer.rootPath,
    storage: contextDisplayPath,
  }, null, 2));
}

function commandCaptureRepair(sourceOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  const node = makeTyp009RepairMemoryNode(source);
  const stored = storeNode(node, "capture-repair");
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-capture-repair",
    action: stored.action,
    supersededHash: stored.supersededHash,
    node: {
      kind: stored.node.kind,
      nodeId: stored.node.nodeId,
      hash: stored.node.hash,
      lifecycle: stored.node.lifecycle,
      parents: stored.node.parents,
      sourceFile: stored.node.sourceAnchor.path,
    },
  }, null, 2));
}

function currentRootHash() {
  return readRootPointer()?.currentRoot ?? readRoot().contextRoot;
}

function readFixPlan(source: string, fixPlanJsonOption: string | boolean | undefined, diagnostics: Diagnostic[]): unknown | null {
  if (typeof fixPlanJsonOption === "string") {
    try {
      return JSON.parse(readFileSync(path.resolve(repoRoot, fixPlanJsonOption), "utf8"));
    } catch (error) {
      pushDiagnostic(diagnostics, {
        code: "CTX_FIX_PLAN_MALFORMED",
        message: error instanceof Error ? error.message : "fix-plan JSON file is malformed",
        path: displayPath(path.resolve(repoRoot, fixPlanJsonOption)),
      });
      return null;
    }
  }
  try {
    const stdout = execFileSync("bin/zero", ["fix", "--plan", "--json", source], { cwd: repoRoot, encoding: "utf8" });
    return JSON.parse(stdout);
  } catch (error) {
    if (isObject(error) && typeof error.stdout === "string" && error.stdout.length > 0) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        pushDiagnostic(diagnostics, {
          code: "CTX_FIX_PLAN_MALFORMED",
          message: "zero fix-plan command emitted malformed JSON",
          path: source,
        });
        return null;
      }
    }
    pushDiagnostic(diagnostics, {
      code: "CTX_FIX_PLAN_FAILED",
      message: error instanceof Error ? error.message : "zero fix-plan command failed",
      path: source,
    });
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformedFixPlan(diagnostics: Diagnostic[], message: string, pathName?: string) {
  pushDiagnostic(diagnostics, {
    code: "CTX_FIX_PLAN_MALFORMED",
    message,
    path: pathName,
  });
}

function hasError(diagnostics: Diagnostic[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity !== "warning");
}

function pushWarning(diagnostics: Diagnostic[], diagnostic: Diagnostic) {
  diagnostics.push({ severity: "warning", ...diagnostic });
}

function parseRange(value: unknown): SourceRange | null {
  if (!isObject(value) || !isObject(value.start) || !isObject(value.end)) return null;
  const start = value.start;
  const end = value.end;
  if (
    typeof start.line !== "number" ||
    typeof start.column !== "number" ||
    typeof end.line !== "number" ||
    typeof end.column !== "number"
  ) {
    return null;
  }
  return {
    start: { line: start.line, column: start.column },
    end: { line: end.line, column: end.column },
    columnUnit: value.columnUnit === "utf8-byte" ? "utf8-byte" : "utf8-byte",
  };
}

function rangeFromLineColumn(edit: Record<string, unknown>, oldText: string): SourceRange | null {
  if (typeof edit.line !== "number") return null;
  if (typeof edit.column === "number") {
    const length = typeof edit.length === "number" ? edit.length : Buffer.byteLength(oldText, "utf8");
    return {
      start: { line: edit.line, column: edit.column },
      end: { line: edit.line, column: edit.column + length },
      columnUnit: "utf8-byte",
    };
  }
  if (typeof edit.path !== "string" || typeof edit.old !== "string") return null;
  const sourcePath = repoRelative(edit.path);
  if (!existsSync(path.join(repoRoot, sourcePath))) return null;
  const line = readText(sourcePath).split(/\n/)[edit.line - 1];
  if (line === undefined) return null;
  const column = line.indexOf(edit.old);
  if (column < 0) return null;
  return {
    start: { line: edit.line, column: column + 1 },
    end: { line: edit.line, column: column + 1 + Buffer.byteLength(oldText, "utf8") },
    columnUnit: "utf8-byte",
  };
}

function normalizeEdit(edit: unknown, diagnostics: Diagnostic[]): FixPlanEdit | null {
  if (!isObject(edit)) {
    malformedFixPlan(diagnostics, "fix-plan edit is not an object");
    return null;
  }
  const pathValue = edit.path ?? edit.sourcePath ?? edit.file;
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    pushDiagnostic(diagnostics, {
      code: "CTX_FIX_PLAN_EDIT_MISSING_PATH",
      message: "fix-plan edit is missing a source path",
    });
    return null;
  }
  const oldText = typeof edit.oldText === "string" ? edit.oldText : typeof edit.old === "string" ? edit.old : null;
  const newText = typeof edit.newText === "string" ? edit.newText : typeof edit.new === "string" ? edit.new : null;
  if (oldText === null || newText === null) {
    malformedFixPlan(diagnostics, "fix-plan edit is missing oldText/newText", repoRelative(pathValue));
    return null;
  }
  const range = parseRange(edit.range) ?? rangeFromLineColumn({ ...edit, path: pathValue }, oldText);
  if (!range) {
    pushDiagnostic(diagnostics, {
      code: "CTX_FIX_PLAN_EDIT_MISSING_RANGE",
      message: "fix-plan edit is missing a source range",
      path: repoRelative(pathValue),
    });
    return null;
  }
  const preconditionValue = edit.precondition;
  const precondition = isObject(preconditionValue) && preconditionValue.kind === "exact-text" && typeof preconditionValue.text === "string"
    ? { kind: "exact-text" as const, text: preconditionValue.text }
    : { kind: "exact-text" as const, text: oldText };
  return {
    path: repoRelative(pathValue),
    range,
    oldText,
    newText,
    precondition,
  };
}

function normalizePatchEdit(patch: unknown, diagnostics: Diagnostic[]): FixPlanEdit | null {
  if (!isObject(patch)) return null;
  if (typeof patch.path !== "string") {
    pushDiagnostic(diagnostics, {
      code: "CTX_FIX_PLAN_EDIT_MISSING_PATH",
      message: "fix-plan patch is missing a source path",
    });
    return null;
  }
  if (typeof patch.line !== "number" || typeof patch.old !== "string" || typeof patch.new !== "string") {
    pushDiagnostic(diagnostics, {
      code: "CTX_FIX_PLAN_EDIT_MISSING_RANGE",
      message: "fix-plan patch is missing line/old/new data",
      path: repoRelative(patch.path),
    });
    return null;
  }
  const oldLine = patch.old;
  const newLine = patch.new;
  const letIndex = oldLine.indexOf("let ");
  if (letIndex >= 0 && newLine.slice(letIndex).startsWith("let mut ")) {
    return {
      path: repoRelative(patch.path),
      range: {
        start: { line: patch.line, column: letIndex + 1 },
        end: { line: patch.line, column: letIndex + 4 },
        columnUnit: "utf8-byte",
      },
      oldText: "let",
      newText: "let mut",
      precondition: { kind: "exact-text", text: "let" },
    };
  }
  const range = rangeFromLineColumn({ path: patch.path, line: patch.line, old: oldLine }, oldLine);
  if (!range) {
    pushDiagnostic(diagnostics, {
      code: "CTX_FIX_PLAN_EDIT_MISSING_RANGE",
      message: "fix-plan patch is missing a derivable source range",
      path: repoRelative(patch.path),
    });
    return null;
  }
  return {
    path: repoRelative(patch.path),
    range,
    oldText: oldLine,
    newText: newLine,
    precondition: { kind: "exact-text", text: oldLine },
  };
}

function matchingDiagnostic(fixPlan: Record<string, unknown>, fix: { diagnosticCode: string; id: string }) {
  const diagnostics = Array.isArray(fixPlan.diagnostics) ? fixPlan.diagnostics : [];
  return diagnostics.find((diagnostic) =>
    isObject(diagnostic) &&
    diagnostic.code === fix.diagnosticCode &&
    isObject(diagnostic.repair) &&
    diagnostic.repair.id === fix.id
  );
}

function deriveTyp009Edit(sourcePath: string): FixPlanEdit | null {
  if (!existsSync(path.join(repoRoot, sourcePath))) return null;
  const source = readText(sourcePath);
  const range = findMakeBindingMutableAnchor(source);
  if (!range) return null;
  return {
    path: sourcePath,
    range,
    oldText: "let",
    newText: "let mut",
    precondition: { kind: "exact-text", text: "let" },
  };
}

function editsForFix(fixPlan: Record<string, unknown>, fix: { diagnosticCode: string; id: string; hasPreview?: boolean }, sourcePath: string, diagnostics: Diagnostic[]): FixPlanEdit[] {
  if (fix.hasPreview === false) return [];
  const fixObject = fix as unknown as Record<string, unknown>;
  if (Array.isArray(fixObject.edits) && fixObject.edits.length > 0) {
    return fixObject.edits
      .map((edit) => normalizeEdit(edit, diagnostics))
      .filter((edit): edit is FixPlanEdit => edit !== null);
  }
  if (Array.isArray(fixPlan.patches) && fixPlan.patches.length > 0) {
    return fixPlan.patches
      .map((patch) => normalizePatchEdit(patch, diagnostics))
      .filter((edit): edit is FixPlanEdit => edit !== null);
  }
  const diagnostic = matchingDiagnostic(fixPlan, fix);
  if (fix.diagnosticCode === "TYP009" && fix.id === "make-binding-mutable" && diagnostic) {
    const derived = deriveTyp009Edit(sourcePath);
    return derived ? [derived] : [];
  }
  return [];
}

function captureFixPlan(source: string, fixPlanJsonOption: string | boolean | undefined) {
  const diagnostics: Diagnostic[] = [];
  const captured: CapturedFixPlanNode[] = [];
  const skipped: SkippedFixPlanNode[] = [];
  const fixPlan = readFixPlan(source, fixPlanJsonOption, diagnostics);
  if (!fixPlan || !isObject(fixPlan)) {
    if (diagnostics.length === 0) malformedFixPlan(diagnostics, "fix-plan JSON root is not an object");
  } else if (!Array.isArray(fixPlan.fixes)) {
    malformedFixPlan(diagnostics, "fix-plan JSON is missing fixes[]");
  } else {
    for (const item of fixPlan.fixes) {
      if (!isObject(item)) {
        malformedFixPlan(diagnostics, "fix-plan fix entry is not an object");
        continue;
      }
      if (
        typeof item.diagnosticCode !== "string" ||
        typeof item.id !== "string" ||
        typeof item.safety !== "string" ||
        typeof item.summary !== "string"
      ) {
        malformedFixPlan(diagnostics, "fix-plan fix entry is missing diagnosticCode/id/safety/summary");
        continue;
      }
      const fix = {
        diagnosticCode: item.diagnosticCode,
        id: item.id,
        safety: item.safety,
        summary: item.summary,
        hasPreview: typeof item.hasPreview === "boolean" ? item.hasPreview : undefined,
        edits: item.edits,
      };
      const edits = editsForFix(fixPlan, fix, source, diagnostics);
      if (edits.length === 0) {
        skipped.push({
          diagnosticCode: fix.diagnosticCode,
          repairId: fix.id,
          reason: "no-preview",
          message: "fix-plan entry does not include preview edits",
        });
        pushWarning(diagnostics, {
          code: "CTX_FIX_PLAN_NO_PREVIEW",
          message: "fix-plan entry does not include preview edits",
          nodeId: repairNodeId(fix.diagnosticCode, fix.id),
          path: source,
        });
        continue;
      }
      const stored = storeNode(makeRepairMemoryNodeFromFix(source, fix, edits), "capture-fix-plan");
      captured.push({
        nodeId: stored.node.nodeId,
        hash: stored.node.hash,
        action: stored.action,
        diagnosticCode: stored.node.diagnosticCode,
        repairId: stored.node.repairId,
        sourceAnchor: {
          path: stored.node.sourceAnchor.path,
          range: stored.node.sourceAnchor.range,
        },
      });
    }
  }
  return {
    schemaVersion: 1,
    mode: "context-capture-fix-plan",
    ok: !hasError(diagnostics),
    sourceFile: source,
    captured,
    skipped,
    diagnostics,
  };
}

function commandCaptureFixPlan(sourceOption: string | boolean | undefined, fixPlanJsonOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  const result = captureFixPlan(source, fixPlanJsonOption);
  console.log(JSON.stringify(result, null, 2));
  const diagnostics = result.diagnostics;
  if (hasError(diagnostics)) process.exitCode = 1;
}

function readZeroJson(args: string[], diagnostics: Diagnostic[], pathName?: string): unknown | null {
  try {
    const stdout = execFileSync("bin/zero", args, { cwd: repoRoot, encoding: "utf8" });
    return JSON.parse(stdout);
  } catch (error) {
    if (isObject(error) && typeof error.stdout === "string" && error.stdout.length > 0) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        pushDiagnostic(diagnostics, {
          code: "CTX_CAPTURE_JSON_MALFORMED",
          message: "zero command emitted malformed JSON",
          path: pathName,
        });
        return null;
      }
    }
    pushDiagnostic(diagnostics, {
      code: "CTX_CAPTURE_COMMAND_FAILED",
      message: error instanceof Error ? error.message : "zero command failed",
      path: pathName,
    });
    return null;
  }
}

function diagnosticRange(diagnostic: Record<string, unknown>): SourceRange | null {
  if (typeof diagnostic.line !== "number" || typeof diagnostic.column !== "number") return null;
  const length = typeof diagnostic.length === "number" ? diagnostic.length : 1;
  return {
    start: { line: diagnostic.line, column: diagnostic.column },
    end: { line: diagnostic.line, column: diagnostic.column + length },
    columnUnit: "utf8-byte",
  };
}

function makeDiagnosticMemoryNode(diagnostic: Record<string, unknown>, sourcePath: string): SemanticNode | null {
  if (typeof diagnostic.code !== "string" || typeof diagnostic.message !== "string") return null;
  const pathValue = typeof diagnostic.path === "string" ? repoRelative(diagnostic.path) : sourcePath;
  const range = diagnosticRange(diagnostic);
  const repair = isObject(diagnostic.repair) && typeof diagnostic.repair.id === "string" ? diagnostic.repair.id : undefined;
  const node: SemanticNode = {
    schemaVersion: 1,
    kind: "diagnostic-memory",
    nodeId: `ctx:diagnostic-memory:${slug(diagnostic.code)}:${slug(pathValue)}:${diagnostic.line ?? "unknown"}:${diagnostic.column ?? "unknown"}`,
    ...(range ? {
      sourceAnchor: {
        path: pathValue,
        range,
        sourceHash: existsSync(path.join(repoRoot, pathValue)) ? sha256File(pathValue) : null,
        status: "active" as const,
      },
    } : {}),
    codes: [
      "DIAGNOSTIC_MEMORY",
      ...(typeof diagnostic.severity === "string" ? [`DIAGNOSTIC_${diagnostic.severity.toUpperCase()}`] : []),
      ...(derivedDiagnosticCode(diagnostic.code) ? [derivedDiagnosticCode(diagnostic.code) as string] : []),
    ],
    diagnosticCode: diagnostic.code,
    repairId: repair,
    severity: typeof diagnostic.severity === "string" ? diagnostic.severity : undefined,
    message: diagnostic.message,
    expected: typeof diagnostic.expected === "string" ? diagnostic.expected : undefined,
    actual: typeof diagnostic.actual === "string" ? diagnostic.actual : undefined,
    help: typeof diagnostic.help === "string" ? diagnostic.help : undefined,
    residualSummary: typeof diagnostic.help === "string" ? diagnostic.help : diagnostic.message,
    projection: {
      kind: "context-projection",
      frontier: {
        diagnostics: [diagnostic.code],
        repairs: repair ? [repair] : [],
        edits: [],
      },
    },
    parents: [],
    lifecycle: activeLifecycle(),
    hash: "",
  };
  node.hash = nodeHash(node);
  return node;
}

function commandCaptureCheck(sourceOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  const diagnostics: Diagnostic[] = [];
  const captured = [];
  const output = readZeroJson(["check", "--json", source], diagnostics, source);
  if (isObject(output) && Array.isArray(output.diagnostics)) {
    for (const diagnostic of output.diagnostics) {
      if (!isObject(diagnostic)) continue;
      const node = makeDiagnosticMemoryNode(diagnostic, source);
      if (!node) continue;
      const stored = storeNode(node, "capture-check");
      captured.push({
        nodeId: stored.node.nodeId,
        hash: stored.node.hash,
        action: stored.action,
        kind: stored.node.kind,
        diagnosticCode: stored.node.diagnosticCode,
        sourceAnchor: stored.node.sourceAnchor ?? null,
      });
    }
  }
  const result = {
    schemaVersion: 1,
    mode: "context-capture-check",
    ok: !hasError(diagnostics),
    sourceFile: source,
    captured,
    diagnostics,
  };
  console.log(JSON.stringify(result, null, 2));
  if (hasError(diagnostics)) process.exitCode = 1;
}

function makeExplainResidualNode(explain: Record<string, unknown>, code: string): SemanticNode {
  const repair = isObject(explain.repair) && typeof explain.repair.id === "string" ? explain.repair.id : undefined;
  const title = typeof explain.title === "string" ? explain.title : code;
  const summary = typeof explain.summary === "string" ? explain.summary : title;
  const node: SemanticNode = {
    schemaVersion: 1,
    kind: "explain-residual",
    nodeId: `ctx:explain-residual:${slug(code)}`,
    codes: [
      "DIAGNOSTIC_EXPLAIN",
      ...(derivedDiagnosticCode(code) ? [derivedDiagnosticCode(code) as string] : []),
    ],
    diagnosticCode: code,
    repairId: repair,
    residualSummary: summary,
    explain: explain as JsonValue,
    projection: {
      kind: "context-projection",
      frontier: {
        diagnostics: [code],
        repairs: repair ? [repair] : [],
        edits: [],
      },
    },
    parents: [],
    lifecycle: activeLifecycle(),
    hash: "",
  };
  node.hash = nodeHash(node);
  return node;
}

function commandCaptureExplain(codeOption: string | boolean | undefined) {
  if (typeof codeOption !== "string") usage();
  ensureLayout();
  const diagnostics: Diagnostic[] = [];
  const captured = [];
  const output = readZeroJson(["explain", "--json", codeOption], diagnostics, codeOption);
  if (isObject(output)) {
    const code = typeof output.code === "string" ? output.code : codeOption;
    const stored = storeNode(makeExplainResidualNode(output, code), "capture-explain");
    captured.push({
      nodeId: stored.node.nodeId,
      hash: stored.node.hash,
      action: stored.action,
      kind: stored.node.kind,
      diagnosticCode: stored.node.diagnosticCode,
    });
  }
  const result = {
    schemaVersion: 1,
    mode: "context-capture-explain",
    ok: !hasError(diagnostics),
    diagnosticCode: codeOption,
    captured,
    diagnostics,
  };
  console.log(JSON.stringify(result, null, 2));
  if (hasError(diagnostics)) process.exitCode = 1;
}

function makeGraphContextNode(sourcePath: string, graph: unknown): SemanticNode {
  const diagnostics = isObject(graph) && Array.isArray(graph.diagnostics)
    ? graph.diagnostics.filter((diagnostic): diagnostic is Record<string, unknown> => isObject(diagnostic))
    : [];
  const node: SemanticNode = {
    schemaVersion: 1,
    kind: "graph-context",
    nodeId: `ctx:graph-context:${slug(sourcePath)}`,
    sourceAnchor: {
      path: sourcePath,
      range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
        columnUnit: "utf8-byte",
      },
      sourceHash: existsSync(path.join(repoRoot, sourcePath)) ? sha256File(sourcePath) : null,
      status: "active",
    },
    codes: ["GRAPH_CONTEXT"],
    residualSummary: `Graph context for ${sourcePath}.`,
    graph: graph as JsonValue,
    projection: {
      kind: "context-projection",
      frontier: {
        diagnostics: diagnostics.map((diagnostic) => typeof diagnostic.code === "string" ? diagnostic.code : "").filter((code) => code.length > 0),
        repairs: [],
        edits: [],
      },
    },
    parents: [],
    lifecycle: activeLifecycle(),
    hash: "",
  };
  node.hash = nodeHash(node);
  return node;
}

function commandCaptureGraph(sourceOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  const diagnostics: Diagnostic[] = [];
  const captured = [];
  const output = readZeroJson(["graph", "--json", source], diagnostics, source);
  if (output !== null) {
    const stored = storeNode(makeGraphContextNode(source, output), "capture-graph");
    captured.push({
      nodeId: stored.node.nodeId,
      hash: stored.node.hash,
      action: stored.action,
      kind: stored.node.kind,
      sourceAnchor: stored.node.sourceAnchor ?? null,
    });
  }
  const result = {
    schemaVersion: 1,
    mode: "context-capture-graph",
    ok: !hasError(diagnostics),
    sourceFile: source,
    captured,
    diagnostics,
  };
  console.log(JSON.stringify(result, null, 2));
  if (hasError(diagnostics)) process.exitCode = 1;
}

function projectNode(node: SemanticNode) {
  return {
    kind: node.kind,
    nodeId: node.nodeId,
    hash: node.hash,
    lifecycle: lifecycleOf(node),
    parents: node.parents,
    codes: node.codes,
    diagnosticCode: node.diagnosticCode,
    repairId: node.repairId,
    severity: node.severity,
    message: node.message,
    expected: node.expected,
    actual: node.actual,
    help: node.help,
    sourceAnchor: node.sourceAnchor,
    explain: node.explain,
    graph: node.graph,
    residualSummary: node.residualSummary,
    frontier: node.projection.frontier,
  };
}

function projectSource(source: string, includeSuperseded: boolean) {
  const diagnostics: Diagnostic[] = [];
  const index = readSourceIndex();
  const root = readRoot();
  const hashes = [...(index.sources[source] ?? [])];
  if (includeSuperseded) {
    for (const hash of supersededNodesOf(root)) {
      const filePath = nodePath(hash);
      if (!existsSync(filePath)) continue;
      const node = readJson<SemanticNode>(filePath);
      if (node.sourceAnchor?.path === source) hashes.push(hash);
    }
  }
  const nodes = [];
  for (const hash of [...new Set(hashes)]) {
    const filePath = nodePath(hash);
    if (!existsSync(filePath)) {
      diagnostics.push({ code: "CTX001", message: "indexed context node is missing", path: source, hash });
      continue;
    }
    nodes.push(projectNode(readJson<SemanticNode>(filePath)));
  }
  return {
    schemaVersion: 1,
    mode: "context-project",
    sourceFile: source,
    nodes,
    diagnostics,
  };
}

function commandProject(sourceOption: string | boolean | undefined, includeSupersededOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  console.log(JSON.stringify(projectSource(source, includeSupersededOption === true), null, 2));
}

function pushDiagnostic(diagnostics: Diagnostic[], diagnostic: Diagnostic) {
  diagnostics.push({ severity: "error", ...diagnostic });
}

function verifyNode(node: SemanticNode, filePath: string, diagnostics: Diagnostic[]): NodeVerification {
  const result: NodeVerification = {
    hash: node.hash,
    nodeId: node.nodeId,
    lifecycle: lifecycleOf(node),
    sourceAnchor: {
      path: node.sourceAnchor?.path ?? null,
      status: node.sourceAnchor?.status ?? "none",
      currentSourceHash: null,
    },
    preconditions: [],
  };
  const actualHash = nodeHash(node);
  if (node.hash !== actualHash) {
    pushDiagnostic(diagnostics, {
      code: "CTX-HASH",
      nodeId: node.nodeId,
      message: "context node hash does not match canonical payload",
      path: filePath,
      expected: node.hash,
      actual: actualHash,
    });
  }
  if (!node.sourceAnchor) return result;
  const sourcePath = path.join(repoRoot, node.sourceAnchor.path);
  if (!existsSync(sourcePath)) {
    pushDiagnostic(diagnostics, {
      code: "CTX_SOURCE_MISSING",
      nodeId: node.nodeId,
      message: "source anchor path does not exist",
      path: node.sourceAnchor.path,
    });
    return result;
  }
  const source = readText(node.sourceAnchor.path);
  const currentSourceHash = sha256File(node.sourceAnchor.path);
  result.sourceAnchor.currentSourceHash = currentSourceHash;
  if (node.sourceAnchor.sourceHash !== null && node.sourceAnchor.sourceHash !== currentSourceHash) {
    pushDiagnostic(diagnostics, {
      code: "CTX_SOURCE_HASH_MISMATCH",
      nodeId: node.nodeId,
      message: "source anchor hash does not match current source",
      path: node.sourceAnchor.path,
      expected: node.sourceAnchor.sourceHash,
      actual: currentSourceHash,
    });
  }
  const extracted = extractRangeText(source, node.sourceAnchor.range);
  if (!extracted.ok) {
    pushDiagnostic(diagnostics, {
      code: "CTX_ANCHOR_RANGE_INVALID",
      nodeId: node.nodeId,
      message: "source anchor range is invalid",
      path: node.sourceAnchor.path,
      actual: extracted.actual,
    });
    return result;
  }
  for (const edit of node.projection.frontier.edits) {
    const precondition = edit.precondition;
    if (!precondition || precondition.kind !== "exact-text") continue;
    const preconditionResult = {
      kind: "exact-text" as const,
      ok: extracted.text === precondition.text,
      expected: precondition.text,
      actual: extracted.text,
    };
    result.preconditions.push(preconditionResult);
    if (!preconditionResult.ok) {
      pushDiagnostic(diagnostics, {
        code: "CTX_PRECONDITION_MISMATCH",
        nodeId: node.nodeId,
        message: "source anchor text does not satisfy exact-text precondition",
        path: node.sourceAnchor.path,
        expected: precondition.text,
        actual: extracted.text,
      });
    }
  }
  return result;
}

function verifyContext(includeSuperseded: boolean) {
  const diagnostics: Diagnostic[] = [];
  const nodeResults: NodeVerification[] = [];
  const root = readRoot();
  const activeNodes = activeNodesOf(root);
  const supersededNodes = supersededNodesOf(root);
  const archivedNodes = archivedNodesOf(root);
  const checkedHashes = includeSuperseded ? allRootNodes(root) : activeNodes;
  const expectedRoot = rootHash(activeNodes, supersededNodes, root.parentRoot, root.reason, archivedNodes);
  if (root.contextRoot !== expectedRoot) {
    pushDiagnostic(diagnostics, {
      code: "CTX-ROOT",
      message: "context root hash does not match canonical payload",
      path: displayPath(rootPath),
      expected: root.contextRoot,
      actual: expectedRoot,
    });
  }
  const index = readSourceIndex();
  const indexedHashes = new Set(Object.values(index.sources).flat());
  for (const hash of checkedHashes) {
    const filePath = nodePath(hash);
    if (!existsSync(filePath)) {
      pushDiagnostic(diagnostics, { code: "CTX001", message: "context root references missing node", path: filePath, hash });
      continue;
    }
    const node = readJson<SemanticNode>(filePath);
    nodeResults.push(verifyNode(node, filePath, diagnostics));
    if (lifecycleOf(node).state === "active" && node.sourceAnchor && !indexedHashes.has(hash)) {
      pushDiagnostic(diagnostics, { code: "CTX-INDEX", nodeId: node.nodeId, message: "context node is missing from source index", path: node.sourceAnchor.path, hash });
    }
  }
  const referencedHashes = new Set(allRootNodes(root));
  for (const filename of existsSync(nodesDir) ? readdirSync(nodesDir).filter((item) => item.endsWith(".json")) : []) {
    const hash = `sha256:${filename.slice(0, -".json".length)}`;
    if (!referencedHashes.has(hash)) pushDiagnostic(diagnostics, { code: "CTX-ORPHAN", message: "node file is not referenced by root", path: displayPath(path.join(nodesDir, filename)), hash });
  }
  return {
    schemaVersion: 1,
    mode: "context-verify",
    ok: diagnostics.length === 0,
    checkedNodes: checkedHashes.length,
    nodes: nodeResults,
    diagnostics,
  };
}

function commandVerify(includeSupersededOption: string | boolean | undefined) {
  ensureLayout();
  const result = verifyContext(includeSupersededOption === true);
  console.log(JSON.stringify(result, null, 2));
  const diagnostics = result.diagnostics;
  if (diagnostics.length > 0) process.exitCode = 1;
}

function commandCheckCycle(sourceOption: string | boolean | undefined, policyOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  const previousRoot = currentRootHash();
  const capture = captureFixPlan(source, undefined);
  const projection = projectSource(source, false);
  const verification = verifyContext(false);
  const currentRoot = currentRootHash();
  const diagnostics = [
    ...capture.diagnostics,
    ...projection.diagnostics,
    ...verification.diagnostics,
  ];
  const rootChanged = previousRoot !== currentRoot;
  const event = writeContextEvent({
    schemaVersion: 1,
    kind: "context-event",
    mode: "context-check-cycle",
    sourceFile: source,
    previousRoot,
    currentRoot,
    rootChanged,
    captured: capture.captured.map((node) => ({
      nodeId: node.nodeId,
      hash: node.hash,
      action: node.action,
    })),
    skipped: capture.skipped,
    verification: {
      ok: verification.ok,
      checkedNodes: verification.checkedNodes,
    },
    diagnostics,
  });
  const compliance = policyOption === undefined ? null : buildComplianceResult(source);
  const policy = compliance ? buildPolicyResult(policyOption, source, compliance) : null;
  const outputDiagnostics = policy ? [...diagnostics, ...policy.diagnostics] : diagnostics;
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-check-cycle",
    sourceFile: source,
    rootTransition: {
      previousRoot,
      currentRoot,
      changed: rootChanged,
    },
    capture: {
      captured: capture.captured,
      skipped: capture.skipped,
    },
    projection: {
      nodes: projection.nodes,
    },
    verification: {
      ok: verification.ok,
      checkedNodes: verification.checkedNodes,
      diagnostics: verification.diagnostics,
    },
    event: {
      eventHash: event.eventHash,
      path: displayPath(eventPath(event.eventHash)),
    },
    ...(policy ? {
      policy: {
        mode: policy.policy.mode,
        ok: policy.policy.ok,
      },
      compliance,
    } : {}),
    diagnostics: outputDiagnostics,
  }, null, 2));
  if (hasError(diagnostics) || (policy && policy.policy.mode !== "advisory" && !policy.policy.ok)) process.exitCode = 1;
}

function readContextEvents(diagnostics: Diagnostic[]) {
  const events: ContextEvent[] = [];
  for (const filename of eventFilenames()) {
    const filePath = path.join(eventsDir, filename);
    try {
      const event = readJson<ContextEvent>(filePath);
      const actualHash = contextEventHash(event);
      if (event.eventHash !== actualHash) {
        pushDiagnostic(diagnostics, {
          code: "CTX_EVENT_HASH_MISMATCH",
          message: "context event hash does not match canonical payload",
          path: displayPath(filePath),
          expected: event.eventHash,
          actual: actualHash,
        });
      }
      events.push(event);
    } catch (error) {
      pushDiagnostic(diagnostics, {
        code: "CTX_EVENT_MALFORMED",
        message: error instanceof Error ? error.message : "context event is not valid JSON",
        path: displayPath(filePath),
      });
    }
  }
  return events.sort((left, right) => left.eventId.localeCompare(right.eventId));
}

function commandEvents() {
  ensureLayout();
  const diagnostics: Diagnostic[] = [];
  const events = readContextEvents(diagnostics);
  const summaries: ContextEventSummary[] = events.map((event) => ({
    eventHash: event.eventHash,
    mode: event.mode,
    sourceFile: event.sourceFile,
    previousRoot: event.previousRoot,
    currentRoot: event.currentRoot,
    rootChanged: event.rootChanged,
  }));
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-events",
    events: summaries,
    diagnostics,
  }, null, 2));
  if (diagnostics.length > 0) process.exitCode = 1;
}

function rootExists(hash: string) {
  return existsSync(rootSnapshotPath(hash));
}

function malformedTimelineEvent(diagnostics: Diagnostic[], message: string, pathName: string) {
  pushDiagnostic(diagnostics, {
    code: "CTX_TIMELINE_EVENT_MALFORMED",
    message,
    path: pathName,
  });
}

function isContextEvent(value: unknown): value is ContextEvent {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    value.kind === "context-event" &&
    typeof value.eventId === "string" &&
    typeof value.eventHash === "string" &&
    (value.mode === "context-check-cycle" || value.mode === "context-reconcile") &&
    typeof value.sourceFile === "string" &&
    typeof value.previousRoot === "string" &&
    typeof value.currentRoot === "string" &&
    typeof value.rootChanged === "boolean" &&
    Array.isArray(value.captured) &&
    Array.isArray(value.skipped) &&
    isObject(value.verification) &&
    typeof value.verification.ok === "boolean" &&
    typeof value.verification.checkedNodes === "number" &&
    Array.isArray(value.diagnostics)
  );
}

function readTimelineEvents(diagnostics: Diagnostic[]) {
  const events: Array<{ event: ContextEvent; eventHashOk: boolean }> = [];
  for (const filename of eventFilenames()) {
    const filePath = path.join(eventsDir, filename);
    const display = displayPath(filePath);
    let value: unknown;
    try {
      value = readJson<unknown>(filePath);
    } catch (error) {
      malformedTimelineEvent(diagnostics, error instanceof Error ? error.message : "context event is not valid JSON", display);
      continue;
    }
    if (!isContextEvent(value)) {
      malformedTimelineEvent(diagnostics, "context event has an unsupported schema", display);
      continue;
    }
    const actualHash = contextEventHash(value);
    const eventHashOk = value.eventHash === actualHash;
    if (!eventHashOk) {
      pushDiagnostic(diagnostics, {
        code: "CTX_TIMELINE_EVENT_HASH_MISMATCH",
        message: "context event hash does not match canonical payload",
        path: display,
        expected: value.eventHash,
        actual: actualHash,
      });
    }
    events.push({ event: value, eventHashOk });
  }
  return events.sort((left, right) => left.event.eventId.localeCompare(right.event.eventId));
}

function timelineForEvent(event: ContextEvent, eventHashOk: boolean, diagnostics: Diagnostic[]): TimelineEvent {
  const previousRootExists = rootExists(event.previousRoot);
  const currentRootExists = rootExists(event.currentRoot);
  if (!previousRootExists) {
    pushDiagnostic(diagnostics, {
      code: "CTX_TIMELINE_ROOT_MISSING",
      message: "timeline event references a missing previous root",
      hash: event.previousRoot,
      path: displayPath(rootSnapshotPath(event.previousRoot)),
    });
  }
  if (!currentRootExists) {
    pushDiagnostic(diagnostics, {
      code: "CTX_TIMELINE_ROOT_MISSING",
      message: "timeline event references a missing current root",
      hash: event.currentRoot,
      path: displayPath(rootSnapshotPath(event.currentRoot)),
    });
  }
  return {
    eventId: event.eventId,
    eventHash: event.eventHash,
    eventHashOk,
    mode: event.mode,
    sourceFile: event.sourceFile,
    previousRoot: event.previousRoot,
    previousRootExists,
    currentRoot: event.currentRoot,
    currentRootExists,
    rootChanged: event.rootChanged,
    captured: event.captured,
    skipped: event.skipped,
    verification: event.verification,
  };
}

function commandTimeline(sourceOption: string | boolean | undefined) {
  ensureLayout();
  const source = typeof sourceOption === "string" ? repoRelative(sourceOption) : null;
  const diagnostics: Diagnostic[] = [];
  const events = readTimelineEvents(diagnostics)
    .filter(({ event }) => source === null || event.sourceFile === source)
    .map(({ event, eventHashOk }) => timelineForEvent(event, eventHashOk, diagnostics));
  const missingRoots = events.reduce((count, event) => count + (event.previousRootExists ? 0 : 1) + (event.currentRootExists ? 0 : 1), 0);
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-timeline",
    sourceFile: source,
    events,
    summary: {
      events: events.length,
      rootTransitions: events.filter((event) => event.rootChanged).length,
      hashFailures: events.filter((event) => !event.eventHashOk).length,
      missingRoots,
    },
    diagnostics,
  }, null, 2));
  if (diagnostics.length > 0) process.exitCode = 1;
}

function rootHashFromSnapshot(root: RootSnapshot) {
  return rootHashForSourceIndex(activeNodesOf(root), root.indexes.sourceIndex, supersededNodesOf(root), root.parentRoot, root.reason, archivedNodesOf(root));
}

function isRootSnapshot(value: unknown): value is RootSnapshot {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.contextRoot === "string" &&
    (typeof value.parentRoot === "string" || value.parentRoot === null) &&
    typeof value.reason === "string" &&
    Array.isArray(value.activeNodes) &&
    Array.isArray(value.supersededNodes) &&
    (Array.isArray(value.archivedNodes) || value.archivedNodes === undefined) &&
    Array.isArray(value.nodes) &&
    isObject(value.indexes) &&
    typeof value.indexes.sourceIndex === "string"
  );
}

function readComplianceRoot(diagnostics: Diagnostic[]): ComplianceRootState {
  const state: ComplianceRootState = {
    pointer: null,
    currentRootSnapshot: null,
    rootHashOk: false,
    parentChainOk: false,
    rootDepth: 0,
  };
  if (!existsSync(rootPath)) {
    pushDiagnostic(diagnostics, {
      code: "CTX_COMPLIANCE_ROOT_MISSING",
      message: "context root pointer does not exist",
      path: displayPath(rootPath),
    });
    return state;
  }
  let pointerValue: unknown;
  try {
    pointerValue = readJson<unknown>(rootPath);
  } catch (error) {
    pushDiagnostic(diagnostics, {
      code: "CTX_COMPLIANCE_ROOT_POINTER_MALFORMED",
      message: error instanceof Error ? error.message : "context root pointer is not valid JSON",
      path: displayPath(rootPath),
    });
    return state;
  }
  if (!isObject(pointerValue) || pointerValue.schemaVersion !== 1 || typeof pointerValue.currentRoot !== "string") {
    pushDiagnostic(diagnostics, {
      code: "CTX_COMPLIANCE_ROOT_POINTER_MALFORMED",
      message: "context root pointer has an unsupported schema",
      path: displayPath(rootPath),
    });
    return state;
  }
  state.pointer = pointerValue as RootPointer;
  const visited = new Set<string>();
  let currentHash: string | null = state.pointer.currentRoot;
  let parentChainOk = true;
  while (currentHash !== null) {
    if (visited.has(currentHash)) {
      parentChainOk = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_PARENT_CHAIN_BROKEN",
        message: "context root parent chain contains a cycle",
        hash: currentHash,
        path: displayPath(rootSnapshotPath(currentHash)),
      });
      break;
    }
    visited.add(currentHash);
    const snapshotPath = rootSnapshotPath(currentHash);
    if (!existsSync(snapshotPath)) {
      parentChainOk = false;
      pushDiagnostic(diagnostics, {
        code: currentHash === state.pointer.currentRoot ? "CTX_COMPLIANCE_ROOT_SNAPSHOT_MISSING" : "CTX_COMPLIANCE_PARENT_ROOT_MISSING",
        message: currentHash === state.pointer.currentRoot ? "current root snapshot does not exist" : "parent root snapshot does not exist",
        hash: currentHash,
        path: displayPath(snapshotPath),
      });
      break;
    }
    let snapshotValue: unknown;
    try {
      snapshotValue = readJson<unknown>(snapshotPath);
    } catch (error) {
      parentChainOk = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_PARENT_CHAIN_BROKEN",
        message: error instanceof Error ? error.message : "root snapshot is not valid JSON",
        hash: currentHash,
        path: displayPath(snapshotPath),
      });
      break;
    }
    if (!isRootSnapshot(snapshotValue)) {
      parentChainOk = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_PARENT_CHAIN_BROKEN",
        message: "root snapshot has an unsupported schema",
        hash: currentHash,
        path: displayPath(snapshotPath),
      });
      break;
    }
    const snapshot = snapshotValue;
    state.rootDepth += 1;
    if (currentHash === state.pointer.currentRoot) state.currentRootSnapshot = snapshot;
    const expectedRoot = rootHashFromSnapshot(snapshot);
    if (snapshot.contextRoot !== currentHash || snapshot.contextRoot !== expectedRoot) {
      parentChainOk = false;
      if (currentHash === state.pointer.currentRoot) state.rootHashOk = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_ROOT_HASH_MISMATCH",
        message: "root snapshot hash does not match canonical payload",
        hash: currentHash,
        path: displayPath(snapshotPath),
        expected: snapshot.contextRoot,
        actual: expectedRoot,
      });
    } else if (currentHash === state.pointer.currentRoot) {
      state.rootHashOk = true;
    }
    currentHash = snapshot.parentRoot;
  }
  state.parentChainOk = parentChainOk && state.currentRootSnapshot !== null;
  return state;
}

function readComplianceEvents(source: string | null, diagnostics: Diagnostic[]) {
  const events: Array<{ event: ContextEvent; eventHashOk: boolean }> = [];
  for (const filename of eventFilenames()) {
    const filePath = path.join(eventsDir, filename);
    const display = displayPath(filePath);
    let value: unknown;
    try {
      value = readJson<unknown>(filePath);
    } catch (error) {
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_EVENT_MALFORMED",
        message: error instanceof Error ? error.message : "context event is not valid JSON",
        path: display,
      });
      continue;
    }
    if (!isContextEvent(value)) {
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_EVENT_MALFORMED",
        message: "context event has an unsupported schema",
        path: display,
      });
      continue;
    }
    if (source !== null && value.sourceFile !== source) continue;
    const actualHash = contextEventHash(value);
    const eventHashOk = value.eventHash === actualHash;
    if (!eventHashOk) {
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_EVENT_HASH_MISMATCH",
        message: "context event hash does not match canonical payload",
        path: display,
        expected: value.eventHash,
        actual: actualHash,
      });
    }
    for (const rootHashValue of [value.previousRoot, value.currentRoot]) {
      if (!rootExists(rootHashValue)) {
        pushDiagnostic(diagnostics, {
          code: "CTX_COMPLIANCE_EVENT_ROOT_MISSING",
          message: "context event references a missing root snapshot",
          hash: rootHashValue,
          path: displayPath(rootSnapshotPath(rootHashValue)),
        });
      }
    }
    events.push({ event: value, eventHashOk });
  }
  return events.sort((left, right) => left.event.eventId.localeCompare(right.event.eventId));
}

function verifyAnchorOnly(node: SemanticNode, diagnostics: Diagnostic[]) {
  if (!node.sourceAnchor) return true;
  const sourcePath = path.join(repoRoot, node.sourceAnchor.path);
  if (!existsSync(sourcePath)) {
    pushDiagnostic(diagnostics, {
      code: "CTX_SOURCE_MISSING",
      nodeId: node.nodeId,
      message: "source anchor path does not exist",
      path: node.sourceAnchor.path,
    });
    return false;
  }
  const source = readText(node.sourceAnchor.path);
  const currentSourceHash = sha256File(node.sourceAnchor.path);
  let ok = true;
  if (node.sourceAnchor.sourceHash !== null && node.sourceAnchor.sourceHash !== currentSourceHash) {
    ok = false;
    pushDiagnostic(diagnostics, {
      code: "CTX_SOURCE_HASH_MISMATCH",
      nodeId: node.nodeId,
      message: "source anchor hash does not match current source",
      path: node.sourceAnchor.path,
      expected: node.sourceAnchor.sourceHash,
      actual: currentSourceHash,
    });
  }
  const extracted = extractRangeText(source, node.sourceAnchor.range);
  if (!extracted.ok) {
    pushDiagnostic(diagnostics, {
      code: "CTX_ANCHOR_RANGE_INVALID",
      nodeId: node.nodeId,
      message: "source anchor range is invalid",
      path: node.sourceAnchor.path,
      actual: extracted.actual,
    });
    return false;
  }
  for (const edit of node.projection.frontier.edits) {
    const precondition = edit.precondition;
    if (!precondition || precondition.kind !== "exact-text") continue;
    if (extracted.text !== precondition.text) {
      ok = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_PRECONDITION_MISMATCH",
        nodeId: node.nodeId,
        message: "source anchor text does not satisfy exact-text precondition",
        path: node.sourceAnchor.path,
        expected: precondition.text,
        actual: extracted.text,
      });
    }
  }
  return ok;
}

function buildComplianceResult(sourceOption: string | boolean | undefined) {
  const source = typeof sourceOption === "string" ? repoRelative(sourceOption) : null;
  const diagnostics: Diagnostic[] = [];
  const rootState = readComplianceRoot(diagnostics);
  const events = readComplianceEvents(source, diagnostics);
  const missingEventRoots = diagnostics.filter((diagnostic) => diagnostic.code === "CTX_COMPLIANCE_EVENT_ROOT_MISSING").length;
  const eventHashFailures = events.filter(({ eventHashOk }) => !eventHashOk).length;
  let sourceIndexOk = true;
  let sourceIndex: SourceIndex | null = null;
  if (!existsSync(sourceIndexPath)) {
    sourceIndexOk = false;
    pushDiagnostic(diagnostics, {
      code: "CTX_COMPLIANCE_SOURCE_INDEX_MISSING",
      message: "source index does not exist",
      path: displayPath(sourceIndexPath),
    });
  } else {
    try {
      sourceIndex = readSourceIndex();
    } catch (error) {
      sourceIndexOk = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_COMPLIANCE_SOURCE_INDEX_MISSING",
        message: error instanceof Error ? error.message : "source index is not valid JSON",
        path: displayPath(sourceIndexPath),
      });
    }
  }

  let active = 0;
  let superseded = 0;
  let nodeHashesOk = true;
  let lifecycleOk = true;
  let anchorsChecked = 0;
  let anchorsOk = true;
  const root = rootState.currentRootSnapshot;
  const activeHashes = new Set(root ? activeNodesOf(root) : []);
  const supersededHashes = new Set(root ? supersededNodesOf(root) : []);
  if (root) {
    const activeNodesBySource: Record<string, string[]> = {};
    for (const hash of activeHashes) {
      const filePath = nodePath(hash);
      if (!existsSync(filePath)) {
        nodeHashesOk = false;
        pushDiagnostic(diagnostics, {
          code: "CTX_COMPLIANCE_NODE_MISSING",
          message: "active context node does not exist",
          hash,
          path: displayPath(filePath),
        });
        continue;
      }
      const node = readNode(hash);
      active += 1;
      if (node.sourceAnchor) activeNodesBySource[node.sourceAnchor.path] = [...(activeNodesBySource[node.sourceAnchor.path] ?? []), hash];
      const actualHash = nodeHash(node);
      if (node.hash !== actualHash || node.hash !== hash) {
        nodeHashesOk = false;
        pushDiagnostic(diagnostics, {
          code: "CTX_COMPLIANCE_NODE_HASH_MISMATCH",
          nodeId: node.nodeId,
          message: "active context node hash does not match canonical payload",
          hash,
          path: displayPath(filePath),
          expected: node.hash,
          actual: actualHash,
        });
      }
      if (lifecycleOf(node).state !== "active") {
        lifecycleOk = false;
        pushDiagnostic(diagnostics, {
          code: "CTX_COMPLIANCE_ACTIVE_NODE_SUPERSEDED",
          nodeId: node.nodeId,
          message: "active root entry points to a superseded node",
          hash,
          path: displayPath(filePath),
        });
      }
      if (node.sourceAnchor && (source === null || node.sourceAnchor.path === source)) {
        anchorsChecked += 1;
        if (!verifyAnchorOnly(node, diagnostics)) anchorsOk = false;
      }
    }
    for (const hash of supersededHashes) {
      const filePath = nodePath(hash);
      if (!existsSync(filePath)) {
        lifecycleOk = false;
        pushDiagnostic(diagnostics, {
          code: "CTX_COMPLIANCE_SUPERSEDED_NODE_MISSING",
          message: "superseded context node does not exist",
          hash,
          path: displayPath(filePath),
        });
        continue;
      }
      const node = readNode(hash);
      superseded += 1;
      if (lifecycleOf(node).state === "active") {
        lifecycleOk = false;
        pushDiagnostic(diagnostics, {
          code: "CTX_COMPLIANCE_SUPERSEDED_NODE_ACTIVE",
          nodeId: node.nodeId,
          message: "superseded root entry points to an active node",
          hash,
          path: displayPath(filePath),
        });
      }
    }
    if (sourceIndex) {
      const indexedSources = source === null ? Object.keys(sourceIndex.sources).sort() : [source];
      for (const sourcePath of indexedSources) {
        for (const hash of sourceIndex.sources[sourcePath] ?? []) {
          if (supersededHashes.has(hash)) {
            sourceIndexOk = false;
            pushDiagnostic(diagnostics, {
              code: "CTX_COMPLIANCE_SOURCE_INDEX_POINTS_TO_SUPERSEDED",
              message: "source index points to a superseded context node",
              hash,
              path: sourcePath,
            });
          } else if (!activeHashes.has(hash) || !existsSync(nodePath(hash))) {
            sourceIndexOk = false;
            pushDiagnostic(diagnostics, {
              code: "CTX_COMPLIANCE_SOURCE_INDEX_STALE",
              message: "source index points to a missing or inactive context node",
              hash,
              path: sourcePath,
            });
          }
        }
      }
      const activeSourceEntries = source === null
        ? Object.entries(activeNodesBySource)
        : [[source, activeNodesBySource[source] ?? []] as [string, string[]]];
      for (const [sourcePath, hashes] of activeSourceEntries) {
        const indexedHashes = new Set(sourceIndex.sources[sourcePath] ?? []);
        for (const hash of hashes) {
          if (!indexedHashes.has(hash)) {
            sourceIndexOk = false;
            pushDiagnostic(diagnostics, {
              code: "CTX_COMPLIANCE_SOURCE_INDEX_STALE",
              message: "source index is missing an active context node",
              hash,
              path: sourcePath,
            });
          }
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    mode: "context-compliance",
    ok: diagnostics.length === 0,
    scope: {
      sourceFile: source,
    },
    root: {
      currentRoot: rootState.pointer?.currentRoot ?? null,
      currentRootExists: rootState.currentRootSnapshot !== null,
      rootHashOk: rootState.rootHashOk,
      parentChainOk: rootState.parentChainOk,
      rootDepth: rootState.rootDepth,
    },
    timeline: {
      events: events.length,
      eventHashesOk: eventHashFailures === 0,
      rootReferencesOk: missingEventRoots === 0,
      missingRoots: missingEventRoots,
      hashFailures: eventHashFailures,
    },
    nodes: {
      active,
      superseded,
      nodeHashesOk,
      lifecycleOk,
    },
    anchors: {
      checked: anchorsChecked,
      ok: anchorsOk,
    },
    indexes: {
      sourceIndexOk,
    },
    diagnostics,
  };
}

function commandCompliance(sourceOption: string | boolean | undefined) {
  const result = buildComplianceResult(sourceOption);
  console.log(JSON.stringify(result, null, 2));
  if (result.diagnostics.length > 0) process.exitCode = 1;
}

function policyModeFromOption(policyOption: string | boolean | undefined): PolicyMode {
  if (policyOption === undefined) return "advisory";
  if (policyOption === "advisory" || policyOption === "verified" || policyOption === "strict") return policyOption;
  usage();
}

function buildPolicyResult(policyOption: string | boolean | undefined, sourceOption: string | boolean | undefined, compliance = buildComplianceResult(sourceOption)) {
  const mode = policyModeFromOption(policyOption);
  const diagnostics: Diagnostic[] = [...compliance.diagnostics];
  let ok = true;
  if (mode === "verified" && !compliance.ok) {
    ok = false;
    pushDiagnostic(diagnostics, {
      code: "CTX_POLICY_COMPLIANCE_FAILED",
      message: "verified context policy requires compliant semantic context",
    });
  }
  if (mode === "strict") {
    if (!compliance.ok) {
      ok = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_POLICY_COMPLIANCE_FAILED",
        message: "strict context policy requires compliant semantic context",
      });
    }
    if (!compliance.anchors.ok) {
      ok = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_POLICY_STRICT_ANCHOR_FAILED",
        message: "strict context policy requires active source anchors to verify",
      });
    }
    if (compliance.timeline.hashFailures !== 0 || compliance.timeline.missingRoots !== 0) {
      ok = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_POLICY_STRICT_TIMELINE_FAILED",
        message: "strict context policy requires an intact semantic timeline",
      });
    }
    if (!compliance.nodes.lifecycleOk) {
      ok = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_POLICY_STRICT_LIFECYCLE_FAILED",
        message: "strict context policy requires consistent node lifecycle state",
      });
    }
    if (!compliance.indexes.sourceIndexOk) {
      ok = false;
      pushDiagnostic(diagnostics, {
        code: "CTX_POLICY_STRICT_INDEX_FAILED",
        message: "strict context policy requires a current source index",
      });
    }
  }
  return {
    schemaVersion: 1,
    mode: "context-policy",
    policy: {
      mode,
      ok: mode === "advisory" ? true : ok,
      status: mode,
    },
    compliance,
    diagnostics,
  };
}

function commandPolicy(sourceOption: string | boolean | undefined, policyOption: string | boolean | undefined) {
  const result = buildPolicyResult(policyOption, sourceOption);
  console.log(JSON.stringify(result, null, 2));
  if (result.policy.mode !== "advisory" && !result.policy.ok) process.exitCode = 1;
}

function findNodeByHashInRoot(root: RootSnapshot, hash: string) {
  if (!allRootNodes(root).includes(hash)) return null;
  const filePath = nodePath(hash);
  if (!existsSync(filePath)) return null;
  return readNode(hash);
}

function reconcileEvent(sourceFile: string, previousRoot: string, diagnostics: Diagnostic[], captured: ContextEvent["captured"]) {
  const currentRoot = currentRootHash();
  return writeContextEvent({
    schemaVersion: 1,
    kind: "context-event",
    mode: "context-reconcile",
    sourceFile,
    previousRoot,
    currentRoot,
    rootChanged: previousRoot !== currentRoot,
    captured,
    skipped: [],
    verification: {
      ok: !hasError(diagnostics),
      checkedNodes: captured.length,
    },
    diagnostics,
  });
}

function sourceReconcileCandidates(source: string) {
  const diagnostics: Diagnostic[] = [];
  const root = readRoot();
  const actions = [];
  for (const hash of activeNodesOf(root)) {
    if (!existsSync(nodePath(hash))) continue;
    const node = readNode(hash);
    if (node.sourceAnchor?.path !== source) continue;
    const nodeDiagnostics: Diagnostic[] = [];
    verifyNode(node, nodePath(hash), nodeDiagnostics);
    for (const diagnostic of nodeDiagnostics) {
      diagnostics.push(diagnostic);
      if (
        diagnostic.code === "CTX_PRECONDITION_MISMATCH" ||
        diagnostic.code === "CTX_ANCHOR_RANGE_INVALID" ||
        diagnostic.code === "CTX_SOURCE_HASH_MISMATCH"
      ) {
        actions.push({
          nodeId: node.nodeId,
          hash,
          action: "refresh-anchor",
          reason: diagnostic.code,
        });
      } else if (diagnostic.code === "CTX_SOURCE_MISSING") {
        actions.push({
          nodeId: node.nodeId,
          hash,
          action: "archive",
          reason: diagnostic.code,
        });
      }
    }
  }
  if (diagnostics.length > 0) {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_SOURCE_VERIFY_FAILED",
      message: "source context verification reported reconcile candidates",
      path: source,
    });
  }
  return {
    schemaVersion: 1,
    mode: "context-reconcile",
    ok: diagnostics.length === 0,
    sourceFile: source,
    actions,
    diagnostics,
  };
}

function findUniqueTextRange(source: string, text: string): SourceRange | null | "ambiguous" {
  if (text.length === 0) return null;
  const matches: SourceRange[] = [];
  const lines = source.split(/\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    let offset = line.indexOf(text);
    while (offset >= 0) {
      matches.push({
        start: {
          line: lineIndex + 1,
          column: Buffer.byteLength(line.slice(0, offset), "utf8") + 1,
        },
        end: {
          line: lineIndex + 1,
          column: Buffer.byteLength(line.slice(0, offset), "utf8") + Buffer.byteLength(text, "utf8") + 1,
        },
        columnUnit: "utf8-byte",
      });
      offset = line.indexOf(text, offset + text.length);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

function requireActiveNode(hashOption: string | boolean | undefined, diagnostics: Diagnostic[]) {
  if (typeof hashOption !== "string") usage();
  const root = readRoot();
  const activeHashes = activeNodesOf(root);
  if (!allRootNodes(root).includes(hashOption)) {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_NODE_NOT_FOUND",
      message: "context node is not referenced by the current root",
      hash: hashOption,
    });
    return null;
  }
  if (!activeHashes.includes(hashOption)) {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_NODE_NOT_ACTIVE",
      message: "reconcile action requires an active context node",
      hash: hashOption,
    });
    return null;
  }
  const node = findNodeByHashInRoot(root, hashOption);
  if (!node) {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_NODE_NOT_FOUND",
      message: "context node file does not exist",
      hash: hashOption,
      path: displayPath(nodePath(hashOption)),
    });
    return null;
  }
  return { root, node, hash: hashOption };
}

function replaceActiveNode(root: RootSnapshot, oldHash: string, oldNode: SemanticNode, nextNode: SemanticNode) {
  const activeNodes = activeNodesOf(root).map((hash) => hash === oldHash ? nextNode.hash : hash);
  const supersededNodes = [...supersededNodesOf(root), oldHash];
  const archivedNodes = archivedNodesOf(root);
  const supersededNode: SemanticNode = {
    ...oldNode,
    lifecycle: {
      ...lifecycleOf(oldNode),
      state: "superseded",
      supersededBy: nextNode.hash,
    },
  };
  writeNode(supersededNode);
  writeNode(nextNode);
  writeRoot(activeNodes, supersededNodes, "reconcile", archivedNodes);
  rebuildSourceIndex(activeNodes);
}

function reconcileArchive(hashOption: string | boolean | undefined) {
  const diagnostics: Diagnostic[] = [];
  const loaded = requireActiveNode(hashOption, diagnostics);
  if (!loaded) return { schemaVersion: 1, mode: "context-reconcile", ok: false, action: "archive", diagnostics };
  const previousRoot = currentRootHash();
  const activeNodes = activeNodesOf(loaded.root).filter((hash) => hash !== loaded.hash);
  const supersededNodes = supersededNodesOf(loaded.root);
  const archivedNodes = [...archivedNodesOf(loaded.root), loaded.hash];
  const archivedNode: SemanticNode = {
    ...loaded.node,
    lifecycle: {
      ...lifecycleOf(loaded.node),
      state: "archived",
    },
  };
  writeNode(archivedNode);
  writeRoot(activeNodes, supersededNodes, "reconcile", archivedNodes);
  rebuildSourceIndex(activeNodes);
  const sourceFile = loaded.node.sourceAnchor?.path ?? "";
  const event = reconcileEvent(sourceFile, previousRoot, diagnostics, [{ nodeId: loaded.node.nodeId, hash: loaded.hash, action: "archived" }]);
  return {
    schemaVersion: 1,
    mode: "context-reconcile",
    ok: true,
    action: "archive",
    node: {
      nodeId: loaded.node.nodeId,
      hash: loaded.hash,
      lifecycle: archivedNode.lifecycle,
      sourceFile,
    },
    rootTransition: {
      previousRoot,
      currentRoot: currentRootHash(),
      changed: previousRoot !== currentRootHash(),
    },
    event: {
      eventHash: event.eventHash,
      path: displayPath(eventPath(event.eventHash)),
    },
    diagnostics,
  };
}

function firstExactTextPrecondition(node: SemanticNode) {
  for (const edit of node.projection.frontier.edits) {
    const precondition = edit.precondition;
    if (precondition?.kind === "exact-text") return precondition.text;
  }
  return null;
}

function reconcileRefreshAnchor(hashOption: string | boolean | undefined) {
  const diagnostics: Diagnostic[] = [];
  const loaded = requireActiveNode(hashOption, diagnostics);
  if (!loaded) return { schemaVersion: 1, mode: "context-reconcile", ok: false, action: "refresh-anchor", diagnostics };
  const preconditionText = firstExactTextPrecondition(loaded.node);
  if (!loaded.node.sourceAnchor || preconditionText === null || !existsSync(path.join(repoRoot, loaded.node.sourceAnchor.path))) {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_ANCHOR_NOT_FOUND",
      message: "refresh-anchor requires an exact-text precondition and readable source",
      hash: loaded.hash,
      path: loaded.node.sourceAnchor?.path,
    });
    return { schemaVersion: 1, mode: "context-reconcile", ok: false, action: "refresh-anchor", diagnostics };
  }
  const source = readText(loaded.node.sourceAnchor.path);
  const range = findUniqueTextRange(source, preconditionText);
  if (range === null) {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_ANCHOR_NOT_FOUND",
      message: "exact-text precondition was not found in source",
      hash: loaded.hash,
      path: loaded.node.sourceAnchor.path,
    });
    return { schemaVersion: 1, mode: "context-reconcile", ok: false, action: "refresh-anchor", diagnostics };
  }
  if (range === "ambiguous") {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_ANCHOR_AMBIGUOUS",
      message: "exact-text precondition appears more than once in source",
      hash: loaded.hash,
      path: loaded.node.sourceAnchor.path,
    });
    return { schemaVersion: 1, mode: "context-reconcile", ok: false, action: "refresh-anchor", diagnostics };
  }
  const previousRoot = currentRootHash();
  const nextNode: SemanticNode = {
    ...loaded.node,
    sourceAnchor: {
      ...loaded.node.sourceAnchor,
      range,
      sourceHash: sha256Text(source),
    },
    parents: [loaded.hash],
    lifecycle: {
      state: "active",
      supersedes: [loaded.hash],
      supersededBy: null,
    },
    hash: "",
  };
  nextNode.hash = nodeHash(nextNode);
  replaceActiveNode(loaded.root, loaded.hash, loaded.node, nextNode);
  const event = reconcileEvent(nextNode.sourceAnchor.path, previousRoot, diagnostics, [{ nodeId: nextNode.nodeId, hash: nextNode.hash, action: "superseded" }]);
  return {
    schemaVersion: 1,
    mode: "context-reconcile",
    ok: true,
    action: "refresh-anchor",
    node: {
      nodeId: nextNode.nodeId,
      hash: nextNode.hash,
      parents: nextNode.parents,
      lifecycle: nextNode.lifecycle,
      sourceAnchor: nextNode.sourceAnchor,
    },
    supersededHash: loaded.hash,
    rootTransition: {
      previousRoot,
      currentRoot: currentRootHash(),
      changed: previousRoot !== currentRootHash(),
    },
    event: {
      eventHash: event.eventHash,
      path: displayPath(eventPath(event.eventHash)),
    },
    diagnostics,
  };
}

function reconcileSupersede(hashOption: string | boolean | undefined, summaryOption: string | boolean | undefined) {
  const diagnostics: Diagnostic[] = [];
  if (typeof summaryOption !== "string") usage();
  const loaded = requireActiveNode(hashOption, diagnostics);
  if (!loaded) return { schemaVersion: 1, mode: "context-reconcile", ok: false, action: "supersede", diagnostics };
  if (!loaded.node.sourceAnchor) {
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_NODE_NOT_FOUND",
      message: "supersede requires a source-anchored node",
      hash: loaded.hash,
    });
    return { schemaVersion: 1, mode: "context-reconcile", ok: false, action: "supersede", diagnostics };
  }
  const previousRoot = currentRootHash();
  const nextNode: SemanticNode = {
    ...loaded.node,
    residualSummary: summaryOption,
    sourceAnchor: {
      ...loaded.node.sourceAnchor,
      sourceHash: existsSync(path.join(repoRoot, loaded.node.sourceAnchor.path)) ? sha256File(loaded.node.sourceAnchor.path) : loaded.node.sourceAnchor.sourceHash,
    },
    parents: [loaded.hash],
    lifecycle: {
      state: "active",
      supersedes: [loaded.hash],
      supersededBy: null,
    },
    hash: "",
  };
  nextNode.hash = nodeHash(nextNode);
  replaceActiveNode(loaded.root, loaded.hash, loaded.node, nextNode);
  const event = reconcileEvent(nextNode.sourceAnchor.path, previousRoot, diagnostics, [{ nodeId: nextNode.nodeId, hash: nextNode.hash, action: "superseded" }]);
  return {
    schemaVersion: 1,
    mode: "context-reconcile",
    ok: true,
    action: "supersede",
    node: {
      nodeId: nextNode.nodeId,
      hash: nextNode.hash,
      parents: nextNode.parents,
      lifecycle: nextNode.lifecycle,
      residualSummary: nextNode.residualSummary,
    },
    supersededHash: loaded.hash,
    rootTransition: {
      previousRoot,
      currentRoot: currentRootHash(),
      changed: previousRoot !== currentRootHash(),
    },
    event: {
      eventHash: event.eventHash,
      path: displayPath(eventPath(event.eventHash)),
    },
    diagnostics,
  };
}

function commandReconcile(sourceOption: string | boolean | undefined, nodeOption: string | boolean | undefined, actionOption: string | boolean | undefined, summaryOption: string | boolean | undefined) {
  ensureLayout();
  let result;
  if (typeof sourceOption === "string" && actionOption === undefined && nodeOption === undefined) {
    result = sourceReconcileCandidates(repoRelative(sourceOption));
  } else if (actionOption === "archive") {
    result = reconcileArchive(nodeOption);
  } else if (actionOption === "refresh-anchor") {
    result = reconcileRefreshAnchor(nodeOption);
  } else if (actionOption === "supersede") {
    result = reconcileSupersede(nodeOption, summaryOption);
  } else if (actionOption === undefined) {
    const diagnostics: Diagnostic[] = [];
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_NO_ACTION",
      message: "reconcile requires --source or --node with --action",
    });
    result = { schemaVersion: 1, mode: "context-reconcile", ok: false, diagnostics };
  } else {
    const diagnostics: Diagnostic[] = [];
    pushDiagnostic(diagnostics, {
      code: "CTX_RECONCILE_UNSUPPORTED_ACTION",
      message: "reconcile action is not supported",
      actual: String(actionOption),
    });
    result = { schemaVersion: 1, mode: "context-reconcile", ok: false, diagnostics };
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function resolveContextInput(input: string) {
  if (input.startsWith("sha256:")) {
    return {
      input,
      contextDir,
      rootPath: rootSnapshotPath(input),
      nodesDir,
    };
  }
  const resolved = path.resolve(repoRoot, input);
  const isJson = path.extname(resolved) === ".json";
  const isRootSnapshot = isJson && path.basename(path.dirname(resolved)) === "roots";
  const rootFile = isJson ? resolved : path.join(resolved, "root.json");
  const dir = isRootSnapshot ? path.dirname(path.dirname(resolved)) : path.dirname(rootFile);
  return {
    input,
    contextDir: dir,
    rootPath: rootFile,
    nodesDir: path.join(dir, "nodes"),
  };
}

function loadRootFromFile(rootFile: string, contextDirForRoot: string) {
  const value = readJson<RootPointer | RootSnapshot>(rootFile);
  if ("currentRoot" in value) {
    const snapshotPath = path.join(contextDirForRoot, "roots", `${value.currentRoot.replace("sha256:", "")}.json`);
    return readJson<RootSnapshot>(snapshotPath);
  }
  return value as RootSnapshot;
}

function loadContext(input: string): LoadedContext {
  const resolved = resolveContextInput(input);
  const diagnostics: Diagnostic[] = [];
  const loaded: LoadedContext = {
    input,
    contextDir: resolved.contextDir,
    rootPath: resolved.rootPath,
    nodesDir: resolved.nodesDir,
    root: null,
    nodesById: new Map(),
    nodesByHash: new Map(),
    diagnostics,
  };
  if (!existsSync(resolved.rootPath)) {
    pushDiagnostic(diagnostics, {
      code: "CTX_DIFF_ROOT_MISSING",
      message: "context root file does not exist",
      path: displayPath(resolved.rootPath),
    });
    return loaded;
  }
  try {
    loaded.root = loadRootFromFile(resolved.rootPath, resolved.contextDir);
  } catch (error) {
    pushDiagnostic(diagnostics, {
      code: "CTX_DIFF_ROOT_MALFORMED",
      message: error instanceof Error ? error.message : "context root is not valid JSON",
      path: displayPath(resolved.rootPath),
    });
    return loaded;
  }
  if (loaded.root.schemaVersion !== 1 || !Array.isArray(loaded.root.nodes)) {
    pushDiagnostic(diagnostics, {
      code: "CTX_DIFF_ROOT_MALFORMED",
      message: "context root has an unsupported schema",
      path: displayPath(resolved.rootPath),
    });
    return loaded;
  }
  const activeHashes = new Set(activeNodesOf(loaded.root));
  for (const hash of allRootNodes(loaded.root)) {
    const filePath = path.join(resolved.nodesDir, `${hash.replace("sha256:", "")}.json`);
    if (!existsSync(filePath)) {
      pushDiagnostic(diagnostics, {
        code: "CTX_DIFF_NODE_MISSING",
        message: "context root references missing node",
        path: displayPath(filePath),
        hash,
      });
      continue;
    }
    try {
      const node = readJson<SemanticNode>(filePath);
      const nodeInSnapshot = activeHashes.has(hash)
        ? {
            ...node,
            lifecycle: {
              ...lifecycleOf(node),
              state: "active" as const,
              supersededBy: null,
            },
          }
        : node;
      loaded.nodesByHash.set(hash, nodeInSnapshot);
      if (activeHashes.has(hash) && loaded.nodesById.has(nodeInSnapshot.nodeId)) {
        pushDiagnostic(diagnostics, {
          code: "CTX_DIFF_DUPLICATE_NODE_ID",
          nodeId: nodeInSnapshot.nodeId,
          message: "context root contains duplicate nodeId entries",
          path: displayPath(filePath),
        });
      }
      if (activeHashes.has(hash)) loaded.nodesById.set(nodeInSnapshot.nodeId, nodeInSnapshot);
    } catch (error) {
      pushDiagnostic(diagnostics, {
        code: "CTX_DIFF_NODE_MALFORMED",
        message: error instanceof Error ? error.message : "context node is not valid JSON",
        path: displayPath(filePath),
        hash,
      });
    }
  }
  return loaded;
}

function summarizeNode(node: SemanticNode): NodeSummary {
  return {
    hash: node.hash,
    nodeId: node.nodeId,
    kind: node.kind,
    lifecycle: lifecycleOf(node),
  };
}

function diffValues(pathName: string, fromValue: JsonValue, toValue: JsonValue, changes: NodeChange[]) {
  if (canonicalize(fromValue) === canonicalize(toValue)) return;
  if (
    fromValue &&
    toValue &&
    typeof fromValue === "object" &&
    typeof toValue === "object" &&
    !Array.isArray(fromValue) &&
    !Array.isArray(toValue)
  ) {
    const keys = new Set([...Object.keys(fromValue), ...Object.keys(toValue)]);
    for (const key of [...keys].sort()) {
      const fromObject = fromValue as { [key: string]: JsonValue };
      const toObject = toValue as { [key: string]: JsonValue };
      diffValues(pathName ? `${pathName}.${key}` : key, fromObject[key] ?? null, toObject[key] ?? null, changes);
    }
    return;
  }
  changes.push({
    path: pathName,
    from: fromValue,
    to: toValue,
  });
}

function diffNodes(fromNode: SemanticNode, toNode: SemanticNode) {
  const changes: NodeChange[] = [];
  diffValues("", withoutHashWithLifecycle(fromNode), withoutHashWithLifecycle(toNode), changes);
  return {
    nodeId: toNode.nodeId,
    fromHash: fromNode.hash,
    toHash: toNode.hash,
    kind: toNode.kind,
    changes,
  };
}

function commandDiff(fromOption: string | boolean | undefined, toOption: string | boolean | undefined) {
  if (typeof fromOption !== "string" || typeof toOption !== "string") usage();
  const fromContext = loadContext(fromOption);
  const toContext = loadContext(toOption);
  const diagnostics = [...fromContext.diagnostics, ...toContext.diagnostics];
  const added: NodeSummary[] = [];
  const removed: NodeSummary[] = [];
  const changed = [];
  const unchanged: NodeSummary[] = [];
  const lifecycleChanged = [];
  if (fromContext.root && toContext.root) {
    const nodeIds = new Set([...fromContext.nodesById.keys(), ...toContext.nodesById.keys()]);
    for (const nodeId of [...nodeIds].sort()) {
      const fromNode = fromContext.nodesById.get(nodeId);
      const toNode = toContext.nodesById.get(nodeId);
      if (!fromNode && toNode) {
        added.push(summarizeNode(toNode));
      } else if (fromNode && !toNode) {
        removed.push(summarizeNode(fromNode));
      } else if (fromNode && toNode && canonicalize(withoutHashWithLifecycle(fromNode)) === canonicalize(withoutHashWithLifecycle(toNode))) {
        unchanged.push(summarizeNode(toNode));
      } else if (fromNode && toNode) {
        changed.push(diffNodes(fromNode, toNode));
      }
    }
    const hashes = new Set([...fromContext.nodesByHash.keys(), ...toContext.nodesByHash.keys()]);
    for (const hash of [...hashes].sort()) {
      const fromNode = fromContext.nodesByHash.get(hash);
      const toNode = toContext.nodesByHash.get(hash);
      if (!fromNode || !toNode) continue;
      const fromLifecycle = lifecycleOf(fromNode);
      const toLifecycle = lifecycleOf(toNode);
      if (canonicalize(fromLifecycle as unknown as JsonValue) !== canonicalize(toLifecycle as unknown as JsonValue)) {
        lifecycleChanged.push({
          hash,
          nodeId: toNode.nodeId,
          from: fromLifecycle,
          to: toLifecycle,
        });
      }
    }
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-diff",
    ok: diagnostics.length === 0,
    from: {
      contextRoot: fromContext.root?.contextRoot ?? null,
    },
    to: {
      contextRoot: toContext.root?.contextRoot ?? null,
    },
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      lifecycleChanged: lifecycleChanged.length,
    },
    nodes: {
      added,
      removed,
      changed,
      unchanged,
      lifecycleChanged,
    },
    diagnostics,
  }, null, 2));
  if (diagnostics.length > 0) process.exitCode = 1;
}

export function main(argv = process.argv.slice(2)) {
  configureContextDir();
  const { command, options } = parseArgs(argv);
  if (command === "init") commandInit();
  else if (command === "capture-repair") commandCaptureRepair(options.source);
  else if (command === "capture-fix-plan") commandCaptureFixPlan(options.source, options.fixPlanJson);
  else if (command === "capture-check") commandCaptureCheck(options.source);
  else if (command === "capture-explain") commandCaptureExplain(options.code);
  else if (command === "capture-graph") commandCaptureGraph(options.source);
  else if (command === "project") commandProject(options.source, options.includeSuperseded);
  else if (command === "verify") commandVerify(options.includeSuperseded);
  else if (command === "check-cycle") commandCheckCycle(options.source, options.policy);
  else if (command === "events") commandEvents();
  else if (command === "timeline") commandTimeline(options.source);
  else if (command === "compliance") commandCompliance(options.source);
  else if (command === "policy") commandPolicy(options.source, options.policy);
  else if (command === "reconcile") commandReconcile(options.source, options.node, options.action, options.summary);
  else if (command === "diff") commandDiff(options.from, options.to);
  else usage();
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) main();
