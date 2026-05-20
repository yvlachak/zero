#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { createHash } from "node:crypto";
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
  kind: "repair-memory";
  nodeId: string;
  sourceAnchor: {
    path: string;
    range: SourceRange;
    sourceHash: string | null;
    status: "active";
  };
  codes: string[];
  diagnosticCode: string;
  repairId: string;
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
  hash: string;
};

type RootFile = {
  schemaVersion: 1;
  contextRoot: string;
  nodes: string[];
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
  severity?: "error";
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
  sourceAnchor: {
    path: string;
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
  root: RootFile | null;
  nodesById: Map<string, SemanticNode>;
  diagnostics: Diagnostic[];
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
function displayPath(filePath: string) {
  const relative = path.relative(repoRoot, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return filePath.split(path.sep).join("/");
}

let contextDir = "";
let nodesDir = "";
let indexesDir = "";
let rootPath = "";
let sourceIndexPath = "";
let contextDisplayPath = "";
let sourceIndexDisplayPath = "";

function configureContextDir(dir = process.env.ZERO_CONTEXT_DIR) {
  contextDir = dir ? path.resolve(repoRoot, dir) : path.join(repoRoot, ".zero/context");
  nodesDir = path.join(contextDir, "nodes");
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
  semantic-context project --source <file> --json
  semantic-context verify --json
  semantic-context diff --from <context-dir> --to <context-dir> --json`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--source") {
      const value = rest[++i];
      if (!value) usage();
      options.source = value;
    } else if (arg === "--from") {
      const value = rest[++i];
      if (!value) usage();
      options.from = value;
    } else if (arg === "--to") {
      const value = rest[++i];
      if (!value) usage();
      options.to = value;
    } else {
      usage();
    }
  }
  if (!command) usage();
  return { command, options };
}

function ensureLayout() {
  mkdirSync(nodesDir, { recursive: true });
  mkdirSync(indexesDir, { recursive: true });
  if (!existsSync(sourceIndexPath)) writeJson(sourceIndexPath, { schemaVersion: 1, sources: {} } satisfies SourceIndex);
  if (!existsSync(rootPath)) writeRoot([]);
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
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function withoutHash(node: SemanticNode): JsonValue {
  const { hash: _hash, ...payload } = node;
  return payload as JsonValue;
}

function rootPayload(nodes: string[]): JsonValue {
  return {
    schemaVersion: 1,
    nodes,
    indexes: {
      sourceIndex: sourceIndexDisplayPath,
    },
  };
}

export function rootPayloadForSourceIndex(nodes: string[], sourceIndex: string): JsonValue {
  return {
    schemaVersion: 1,
    nodes,
    indexes: {
      sourceIndex,
    },
  };
}

export function nodeHash(node: SemanticNode) {
  return sha256Text(canonicalize(withoutHash(node)));
}

function rootHash(nodes: string[]) {
  return sha256Text(canonicalize(rootPayload(nodes)));
}

export function rootHashForSourceIndex(nodes: string[], sourceIndex: string) {
  return sha256Text(canonicalize(rootPayloadForSourceIndex(nodes, sourceIndex)));
}

function writeJson(filePath: string, value: JsonValue) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeRoot(nodes: string[]) {
  const sortedNodes = [...new Set(nodes)].sort();
  const root: RootFile = {
    schemaVersion: 1,
    contextRoot: rootHash(sortedNodes),
    nodes: sortedNodes,
    indexes: {
      sourceIndex: sourceIndexDisplayPath,
    },
  };
  writeJson(rootPath, root as unknown as JsonValue);
}

function readRoot() {
  return readJson<RootFile>(rootPath);
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
    hash: "",
  };
  node.hash = nodeHash(node);
  return node;
}

function storeNode(node: SemanticNode) {
  writeJson(nodePath(node.hash), node as unknown as JsonValue);
  const root = readRoot();
  writeRoot([...root.nodes, node.hash]);
  const index = readSourceIndex();
  index.sources[node.sourceAnchor.path] = [...(index.sources[node.sourceAnchor.path] ?? []), node.hash];
  writeSourceIndex(index);
}

function commandInit() {
  ensureLayout();
  const root = readRoot();
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-init",
    contextRoot: root.contextRoot,
    storage: contextDisplayPath,
  }, null, 2));
}

function commandCaptureRepair(sourceOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  const node = makeTyp009RepairMemoryNode(source);
  storeNode(node);
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-capture-repair",
    node: {
      kind: node.kind,
      nodeId: node.nodeId,
      hash: node.hash,
      sourceFile: node.sourceAnchor.path,
    },
  }, null, 2));
}

function projectNode(node: SemanticNode) {
  return {
    kind: node.kind,
    nodeId: node.nodeId,
    hash: node.hash,
    codes: node.codes,
    diagnosticCode: node.diagnosticCode,
    repairId: node.repairId,
    residualSummary: node.residualSummary,
    frontier: node.projection.frontier,
  };
}

function commandProject(sourceOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
  const diagnostics: Diagnostic[] = [];
  const index = readSourceIndex();
  const hashes = index.sources[source] ?? [];
  const nodes = [];
  for (const hash of hashes) {
    const filePath = nodePath(hash);
    if (!existsSync(filePath)) {
      diagnostics.push({ code: "CTX001", message: "indexed context node is missing", path: source, hash });
      continue;
    }
    nodes.push(projectNode(readJson<SemanticNode>(filePath)));
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-project",
    sourceFile: source,
    nodes,
    diagnostics,
  }, null, 2));
}

function pushDiagnostic(diagnostics: Diagnostic[], diagnostic: Diagnostic) {
  diagnostics.push({ severity: "error", ...diagnostic });
}

function verifyNode(node: SemanticNode, filePath: string, diagnostics: Diagnostic[]): NodeVerification {
  const result: NodeVerification = {
    hash: node.hash,
    nodeId: node.nodeId,
    sourceAnchor: {
      path: node.sourceAnchor.path,
      status: node.sourceAnchor.status,
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

function commandVerify() {
  ensureLayout();
  const diagnostics: Diagnostic[] = [];
  const nodeResults: NodeVerification[] = [];
  const root = readRoot();
  const expectedRoot = rootHash(root.nodes);
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
  for (const hash of root.nodes) {
    const filePath = nodePath(hash);
    if (!existsSync(filePath)) {
      pushDiagnostic(diagnostics, { code: "CTX001", message: "context root references missing node", path: filePath, hash });
      continue;
    }
    const node = readJson<SemanticNode>(filePath);
    nodeResults.push(verifyNode(node, filePath, diagnostics));
    if (!indexedHashes.has(hash)) {
      pushDiagnostic(diagnostics, { code: "CTX-INDEX", nodeId: node.nodeId, message: "context node is missing from source index", path: node.sourceAnchor.path, hash });
    }
  }
  for (const filename of existsSync(nodesDir) ? readdirSync(nodesDir).filter((item) => item.endsWith(".json")) : []) {
    const hash = `sha256:${filename.slice(0, -".json".length)}`;
    if (!root.nodes.includes(hash)) pushDiagnostic(diagnostics, { code: "CTX-ORPHAN", message: "node file is not referenced by root", path: displayPath(path.join(nodesDir, filename)), hash });
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-verify",
    ok: diagnostics.length === 0,
    checkedNodes: root.nodes.length,
    nodes: nodeResults,
    diagnostics,
  }, null, 2));
  if (diagnostics.length > 0) process.exitCode = 1;
}

function resolveContextInput(input: string) {
  const resolved = path.resolve(repoRoot, input);
  const rootFile = path.basename(resolved) === "root.json" ? resolved : path.join(resolved, "root.json");
  const dir = path.dirname(rootFile);
  return {
    input,
    contextDir: dir,
    rootPath: rootFile,
    nodesDir: path.join(dir, "nodes"),
  };
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
    loaded.root = readJson<RootFile>(resolved.rootPath);
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
  for (const hash of loaded.root.nodes) {
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
      if (loaded.nodesById.has(node.nodeId)) {
        pushDiagnostic(diagnostics, {
          code: "CTX_DIFF_DUPLICATE_NODE_ID",
          nodeId: node.nodeId,
          message: "context root contains duplicate nodeId entries",
          path: displayPath(filePath),
        });
      }
      loaded.nodesById.set(node.nodeId, node);
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
  diffValues("", withoutHash(fromNode), withoutHash(toNode), changes);
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
  if (fromContext.root && toContext.root) {
    const nodeIds = new Set([...fromContext.nodesById.keys(), ...toContext.nodesById.keys()]);
    for (const nodeId of [...nodeIds].sort()) {
      const fromNode = fromContext.nodesById.get(nodeId);
      const toNode = toContext.nodesById.get(nodeId);
      if (!fromNode && toNode) {
        added.push(summarizeNode(toNode));
      } else if (fromNode && !toNode) {
        removed.push(summarizeNode(fromNode));
      } else if (fromNode && toNode && fromNode.hash === toNode.hash) {
        unchanged.push(summarizeNode(toNode));
      } else if (fromNode && toNode) {
        changed.push(diffNodes(fromNode, toNode));
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
    },
    nodes: {
      added,
      removed,
      changed,
      unchanged,
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
  else if (command === "project") commandProject(options.source);
  else if (command === "verify") commandVerify();
  else if (command === "diff") commandDiff(options.from, options.to);
  else usage();
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) main();
