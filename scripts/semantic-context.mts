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
  diagnosticCode: string;
  repairId: string;
  sourceAnchor: {
    path: string;
    range: SourceRange;
  };
};

type SkippedFixPlanNode = {
  diagnosticCode: string | null;
  repairId: string | null;
  reason: string;
  message: string;
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
  semantic-context capture-fix-plan --source <file> [--fix-plan-json <path>]
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
    } else if (arg === "--fix-plan-json") {
      const value = rest[++i];
      if (!value) usage();
      options.fixPlanJson = value;
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

function commandCaptureFixPlan(sourceOption: string | boolean | undefined, fixPlanJsonOption: string | boolean | undefined) {
  if (typeof sourceOption !== "string") usage();
  ensureLayout();
  const source = repoRelative(sourceOption);
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
      const node = makeRepairMemoryNodeFromFix(source, fix, edits);
      storeNode(node);
      captured.push({
        nodeId: node.nodeId,
        hash: node.hash,
        diagnosticCode: node.diagnosticCode,
        repairId: node.repairId,
        sourceAnchor: {
          path: node.sourceAnchor.path,
          range: node.sourceAnchor.range,
        },
      });
    }
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "context-capture-fix-plan",
    ok: !hasError(diagnostics),
    sourceFile: source,
    captured,
    skipped,
    diagnostics,
  }, null, 2));
  if (hasError(diagnostics)) process.exitCode = 1;
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
  else if (command === "capture-fix-plan") commandCaptureFixPlan(options.source, options.fixPlanJson);
  else if (command === "project") commandProject(options.source);
  else if (command === "verify") commandVerify();
  else if (command === "diff") commandDiff(options.from, options.to);
  else usage();
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) main();
