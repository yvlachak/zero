#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const storage = path.join("/tmp", `zero-semantic-context-${process.pid}`);
const fixtureDir = path.join("/tmp", `zero-semantic-context-fixtures-${process.pid}`);
const source = "conformance/native/fail/mem-copy-immutable-dst.0";

process.env.ZERO_CONTEXT_DIR = storage;
const { main, nodeHash, rootHashForSourceIndex } = await import("./semantic-context.mts");

function run(args: string[], options: { allowFailure?: boolean; storage?: string } = {}): any {
  const originalLog = console.log;
  const priorExitCode = process.exitCode;
  const priorContextDir = process.env.ZERO_CONTEXT_DIR;
  let stdout = "";
  process.exitCode = undefined;
  process.env.ZERO_CONTEXT_DIR = options.storage ?? storage;
  console.log = (value?: unknown) => {
    stdout += `${String(value ?? "")}\n`;
  };
  try {
    main(args);
  } finally {
    console.log = originalLog;
  }
  if (!options.allowFailure) assert.equal(process.exitCode ?? 0, 0);
  process.exitCode = priorExitCode;
  process.env.ZERO_CONTEXT_DIR = priorContextDir;
  return JSON.parse(stdout);
}

function resetStorage(dir = storage) {
  rmSync(dir, { recursive: true, force: true });
}

function tempFixture(name: string) {
  mkdirSync(fixtureDir, { recursive: true });
  const target = path.join(fixtureDir, name);
  writeFileSync(target, readFileSync(path.join(repoRoot, source), "utf8"));
  return target;
}

function captureContext(dir: string) {
  resetStorage(dir);
  run(["init"], { storage: dir });
  return run(["capture-repair", "--source", source], { storage: dir });
}

function mutateResidualSummary(dir: string, summary: string) {
  const rootPath = path.join(dir, "root.json");
  const indexPath = path.join(dir, "indexes/source-index.json");
  const root = JSON.parse(readFileSync(rootPath, "utf8"));
  const oldHash = root.nodes[0];
  const oldNodePath = path.join(dir, "nodes", `${oldHash.replace("sha256:", "")}.json`);
  const node = JSON.parse(readFileSync(oldNodePath, "utf8"));
  node.residualSummary = summary;
  node.hash = nodeHash(node);
  const newNodePath = path.join(dir, "nodes", `${node.hash.replace("sha256:", "")}.json`);
  writeFileSync(newNodePath, `${JSON.stringify(node, null, 2)}\n`);
  rmSync(oldNodePath, { force: true });
  root.nodes = [node.hash];
  root.contextRoot = rootHashForSourceIndex(root.nodes, indexPath.split(path.sep).join("/"));
  writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.sources[node.sourceAnchor.path] = [node.hash];
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return node;
}

try {
  resetStorage();

  const init = run(["init"]);
  assert.equal(init.schemaVersion, 1);
  assert.equal(init.mode, "context-init");
  assert.equal(init.storage, storage);
  assert.match(init.contextRoot, /^sha256:[0-9a-f]{64}$/);

  const capture = run(["capture-repair", "--source", source]);
  assert.equal(capture.mode, "context-capture-repair");
  assert.equal(capture.node.kind, "repair-memory");
  assert.equal(capture.node.nodeId, "ctx:repair-memory:typ009:make-binding-mutable");
  assert.match(capture.node.hash, /^sha256:[0-9a-f]{64}$/);

  const secondCapture = run(["capture-repair", "--source", source]);
  assert.equal(secondCapture.node.hash, capture.node.hash);

  const project = run(["project", "--source", source, "--json"]);
  assert.equal(project.schemaVersion, 1);
  assert.equal(project.mode, "context-project");
  assert.equal(project.sourceFile, source);
  assert.equal(project.nodes.length, 1);
  assert.equal(project.nodes[0].hash, capture.node.hash);
  assert.equal(project.nodes[0].diagnosticCode, "TYP009");
  assert.equal(project.nodes[0].repairId, "make-binding-mutable");
  assert.deepEqual(project.nodes[0].frontier.diagnostics, ["TYP009"]);
  assert.deepEqual(project.nodes[0].frontier.repairs, ["make-binding-mutable"]);
  assert.equal(project.nodes[0].frontier.edits[0].oldText, "let");
  assert.equal(project.nodes[0].frontier.edits[0].newText, "let mut");
  assert.deepEqual(project.diagnostics, []);

  const emptyProject = run(["project", "--source", "examples/hello.0", "--json"]);
  assert.equal(emptyProject.mode, "context-project");
  assert.equal(emptyProject.sourceFile, "examples/hello.0");
  assert.deepEqual(emptyProject.nodes, []);
  assert.deepEqual(emptyProject.diagnostics, []);

  const verify = run(["verify", "--json"]);
  assert.equal(verify.schemaVersion, 1);
  assert.equal(verify.mode, "context-verify");
  assert.equal(verify.ok, true);
  assert.equal(verify.checkedNodes, 1);
  assert.equal(verify.nodes.length, 1);
  assert.equal(verify.nodes[0].hash, capture.node.hash);
  assert.equal(verify.nodes[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");
  assert.equal(verify.nodes[0].sourceAnchor.path, source);
  assert.equal(verify.nodes[0].sourceAnchor.status, "active");
  assert.match(verify.nodes[0].sourceAnchor.currentSourceHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(verify.nodes[0].preconditions, [
    {
      kind: "exact-text",
      ok: true,
      expected: "let",
      actual: "let",
    },
  ]);
  assert.deepEqual(verify.diagnostics, []);

  const nodeFile = path.join(storage, "nodes", `${capture.node.hash.replace("sha256:", "")}.json`);
  assert.equal(existsSync(nodeFile), true);
  const storedNode = JSON.parse(readFileSync(nodeFile, "utf8"));
  assert.equal(storedNode.hash, capture.node.hash);
  assert.match(storedNode.sourceAnchor.sourceHash, /^sha256:[0-9a-f]{64}$/);

  resetStorage();
  const mismatchSource = tempFixture("precondition-mismatch.0");
  const mismatchCapture = run(["capture-repair", "--source", mismatchSource]);
  let mismatchText = readFileSync(mismatchSource, "utf8");
  mismatchText = mismatchText.replace("    let dst", "    var dst");
  writeFileSync(mismatchSource, mismatchText);
  const mismatchVerify = run(["verify", "--json"], { allowFailure: true });
  assert.equal(mismatchVerify.ok, false);
  assert.equal(mismatchVerify.checkedNodes, 1);
  assert.equal(mismatchVerify.nodes[0].hash, mismatchCapture.node.hash);
  assert.equal(mismatchVerify.nodes[0].preconditions[0].ok, false);
  assert.equal(mismatchVerify.nodes[0].preconditions[0].expected, "let");
  assert.equal(mismatchVerify.nodes[0].preconditions[0].actual, "var");
  assert(mismatchVerify.diagnostics.some((diagnostic: any) =>
    diagnostic.code === "CTX_PRECONDITION_MISMATCH" &&
    diagnostic.severity === "error" &&
    diagnostic.nodeId === "ctx:repair-memory:typ009:make-binding-mutable" &&
    diagnostic.expected === "let" &&
    diagnostic.actual === "var"
  ));
  assert(mismatchVerify.diagnostics.some((diagnostic: any) => diagnostic.code === "CTX_SOURCE_HASH_MISMATCH"));

  resetStorage();
  const missingSource = tempFixture("missing-source.0");
  const missingCapture = run(["capture-repair", "--source", missingSource]);
  rmSync(missingSource, { force: true });
  const missingVerify = run(["verify", "--json"], { allowFailure: true });
  assert.equal(missingVerify.ok, false);
  assert.equal(missingVerify.checkedNodes, 1);
  assert.equal(missingVerify.nodes[0].hash, missingCapture.node.hash);
  assert.equal(missingVerify.nodes[0].sourceAnchor.currentSourceHash, null);
  assert(missingVerify.diagnostics.some((diagnostic: any) =>
    diagnostic.code === "CTX_SOURCE_MISSING" &&
    diagnostic.severity === "error" &&
    diagnostic.nodeId === "ctx:repair-memory:typ009:make-binding-mutable"
  ));

  const sameA = path.join("/tmp", `zero-semantic-context-same-a-${process.pid}`);
  const sameB = path.join("/tmp", `zero-semantic-context-same-b-${process.pid}`);
  const addedA = path.join("/tmp", `zero-semantic-context-added-a-${process.pid}`);
  const addedB = path.join("/tmp", `zero-semantic-context-added-b-${process.pid}`);
  const changedA = path.join("/tmp", `zero-semantic-context-changed-a-${process.pid}`);
  const changedB = path.join("/tmp", `zero-semantic-context-changed-b-${process.pid}`);
  try {
    const sameCaptureA = captureContext(sameA);
    const sameCaptureB = captureContext(sameB);
    assert.equal(sameCaptureA.node.hash, sameCaptureB.node.hash);
    const identicalDiff = run(["diff", "--from", sameA, "--to", sameB, "--json"]);
    assert.equal(identicalDiff.schemaVersion, 1);
    assert.equal(identicalDiff.mode, "context-diff");
    assert.equal(identicalDiff.ok, true);
    assert.deepEqual(identicalDiff.summary, { added: 0, removed: 0, changed: 0, unchanged: 1 });
    assert.equal(identicalDiff.nodes.unchanged[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");

    resetStorage(addedA);
    run(["init"], { storage: addedA });
    const addedCapture = captureContext(addedB);
    const addedDiff = run(["diff", "--from", addedA, "--to", addedB, "--json"]);
    assert.equal(addedDiff.ok, true);
    assert.deepEqual(addedDiff.summary, { added: 1, removed: 0, changed: 0, unchanged: 0 });
    assert.equal(addedDiff.nodes.added[0].hash, addedCapture.node.hash);

    const removedDiff = run(["diff", "--from", addedB, "--to", addedA, "--json"]);
    assert.equal(removedDiff.ok, true);
    assert.deepEqual(removedDiff.summary, { added: 0, removed: 1, changed: 0, unchanged: 0 });
    assert.equal(removedDiff.nodes.removed[0].hash, addedCapture.node.hash);

    captureContext(changedA);
    captureContext(changedB);
    const changedNode = mutateResidualSummary(changedB, "Changed residual summary for semantic diff testing.");
    const changedDiff = run(["diff", "--from", changedA, "--to", changedB, "--json"]);
    assert.equal(changedDiff.ok, true);
    assert.deepEqual(changedDiff.summary, { added: 0, removed: 0, changed: 1, unchanged: 0 });
    assert.equal(changedDiff.nodes.changed[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");
    assert.equal(changedDiff.nodes.changed[0].toHash, changedNode.hash);
    assert(changedDiff.nodes.changed[0].changes.some((change: any) =>
      change.path === "residualSummary" &&
      change.to === "Changed residual summary for semantic diff testing."
    ));
  } finally {
    for (const dir of [sameA, sameB, addedA, addedB, changedA, changedB]) resetStorage(dir);
  }

  console.log("semantic context smoke ok");
} finally {
  rmSync(storage, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
}
