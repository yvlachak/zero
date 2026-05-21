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

function tempJson(name: string, value: any) {
  mkdirSync(fixtureDir, { recursive: true });
  const target = path.join(fixtureDir, name);
  writeFileSync(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

function snapshotPath(dir: string, hash: string) {
  return path.join(dir, "roots", `${hash.replace("sha256:", "")}.json`);
}

function readRootPointer(dir = storage) {
  return JSON.parse(readFileSync(path.join(dir, "root.json"), "utf8"));
}

function readRootSnapshot(dir = storage, hash = readRootPointer(dir).currentRoot) {
  return JSON.parse(readFileSync(snapshotPath(dir, hash), "utf8"));
}

function captureContext(dir: string) {
  resetStorage(dir);
  run(["init"], { storage: dir });
  return run(["capture-repair", "--source", source], { storage: dir });
}

function mutateResidualSummary(dir: string, summary: string) {
  const indexPath = path.join(dir, "indexes/source-index.json");
  const pointer = readRootPointer(dir);
  const root = readRootSnapshot(dir);
  const oldHash = root.nodes[0];
  const oldNodePath = path.join(dir, "nodes", `${oldHash.replace("sha256:", "")}.json`);
  const node = JSON.parse(readFileSync(oldNodePath, "utf8"));
  node.residualSummary = summary;
  node.hash = nodeHash(node);
  const newNodePath = path.join(dir, "nodes", `${node.hash.replace("sha256:", "")}.json`);
  writeFileSync(newNodePath, `${JSON.stringify(node, null, 2)}\n`);
  rmSync(oldNodePath, { force: true });
  root.nodes = [node.hash];
  root.activeNodes = [node.hash];
  root.supersededNodes = root.supersededNodes ?? [];
  root.contextRoot = rootHashForSourceIndex(root.nodes, indexPath.split(path.sep).join("/"), root.supersededNodes, root.parentRoot, root.reason);
  writeFileSync(snapshotPath(dir, root.contextRoot), `${JSON.stringify(root, null, 2)}\n`);
  pointer.currentRoot = root.contextRoot;
  pointer.rootPath = snapshotPath(dir, root.contextRoot).split(path.sep).join("/");
  writeFileSync(path.join(dir, "root.json"), `${JSON.stringify(pointer, null, 2)}\n`);
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
  assert.equal(init.currentRoot, init.contextRoot);
  assert.equal(init.previousRoot, null);
  assert.match(init.rootPath, /roots\/[0-9a-f]{64}\.json$/);
  const initPointer = readRootPointer();
  assert.equal(initPointer.currentRoot, init.contextRoot);
  assert.equal(initPointer.previousRoot, null);
  assert.equal(existsSync(snapshotPath(storage, init.contextRoot)), true);
  const initSnapshot = readRootSnapshot(storage, init.contextRoot);
  assert.equal(initSnapshot.contextRoot, init.contextRoot);
  assert.equal(initSnapshot.parentRoot, null);
  assert.equal(initSnapshot.reason, "init");
  assert.deepEqual(initSnapshot.activeNodes, []);
  assert.deepEqual(initSnapshot.supersededNodes, []);
  assert.deepEqual(initSnapshot.nodes, []);
  assert.equal(initSnapshot.createdAt, null);

  const capture = run(["capture-repair", "--source", source]);
  assert.equal(capture.mode, "context-capture-repair");
  assert.equal(capture.action, "added");
  assert.equal(capture.node.kind, "repair-memory");
  assert.equal(capture.node.nodeId, "ctx:repair-memory:typ009:make-binding-mutable");
  assert.deepEqual(capture.node.parents, []);
  assert.equal(capture.node.lifecycle.state, "active");
  assert.match(capture.node.hash, /^sha256:[0-9a-f]{64}$/);
  const firstCapturePointer = readRootPointer();
  const firstCaptureSnapshot = readRootSnapshot(storage, firstCapturePointer.currentRoot);
  assert.notEqual(firstCapturePointer.currentRoot, init.contextRoot);
  assert.equal(firstCapturePointer.previousRoot, init.contextRoot);
  assert.equal(firstCaptureSnapshot.parentRoot, init.contextRoot);
  assert.equal(firstCaptureSnapshot.reason, "capture-repair");
  assert.deepEqual(firstCaptureSnapshot.activeNodes, [capture.node.hash]);

  const secondCapture = run(["capture-repair", "--source", source]);
  assert.equal(secondCapture.action, "unchanged");
  assert.equal(secondCapture.node.hash, capture.node.hash);
  const repeatedPointer = readRootPointer();
  assert.equal(repeatedPointer.currentRoot, firstCapturePointer.currentRoot);
  const repeatedRoot = readRootSnapshot();
  assert.deepEqual(repeatedRoot.nodes, [capture.node.hash]);
  assert.deepEqual(repeatedRoot.activeNodes, [capture.node.hash]);
  assert.deepEqual(repeatedRoot.supersededNodes, []);

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
  assert.equal(storedNode.lifecycle.state, "active");
  assert.deepEqual(storedNode.lifecycle.supersedes, []);
  assert.equal(storedNode.lifecycle.supersededBy, null);
  assert.match(storedNode.sourceAnchor.sourceHash, /^sha256:[0-9a-f]{64}$/);

  resetStorage();
  const fixPlanCapture = run(["capture-fix-plan", "--source", source]);
  assert.equal(fixPlanCapture.schemaVersion, 1);
  assert.equal(fixPlanCapture.mode, "context-capture-fix-plan");
  assert.equal(fixPlanCapture.ok, true);
  assert.equal(fixPlanCapture.sourceFile, source);
  assert.equal(fixPlanCapture.captured.length, 1);
  assert.equal(fixPlanCapture.captured[0].action, "added");
  assert.equal(fixPlanCapture.captured[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");
  assert.equal(fixPlanCapture.captured[0].diagnosticCode, "TYP009");
  assert.equal(fixPlanCapture.captured[0].repairId, "make-binding-mutable");
  assert.equal(fixPlanCapture.skipped.length, 0);
  assert.deepEqual(fixPlanCapture.diagnostics, []);

  const fixPlanProject = run(["project", "--source", source, "--json"]);
  assert.equal(fixPlanProject.nodes.length, 1);
  assert.equal(fixPlanProject.nodes[0].hash, fixPlanCapture.captured[0].hash);
  assert.equal(fixPlanProject.nodes[0].diagnosticCode, "TYP009");
  assert.equal(fixPlanProject.nodes[0].repairId, "make-binding-mutable");
  assert.deepEqual(fixPlanProject.nodes[0].frontier.diagnostics, ["TYP009"]);
  assert.deepEqual(fixPlanProject.nodes[0].frontier.repairs, ["make-binding-mutable"]);
  assert.equal(fixPlanProject.nodes[0].frontier.edits[0].oldText, "let");
  assert.equal(fixPlanProject.nodes[0].frontier.edits[0].newText, "let mut");
  assert.deepEqual(fixPlanProject.diagnostics, []);

  const fixPlanVerify = run(["verify", "--json"]);
  assert.equal(fixPlanVerify.ok, true);
  assert.equal(fixPlanVerify.checkedNodes, 1);
  assert.equal(fixPlanVerify.nodes[0].hash, fixPlanCapture.captured[0].hash);
  assert.equal(fixPlanVerify.nodes[0].preconditions[0].ok, true);
  assert.deepEqual(fixPlanVerify.diagnostics, []);

  resetStorage();
  run(["init"]);
  const cycleBeforeRoot = readRootPointer().currentRoot;
  const checkCycle = run(["check-cycle", "--source", source, "--json"]);
  assert.equal(checkCycle.schemaVersion, 1);
  assert.equal(checkCycle.mode, "context-check-cycle");
  assert.equal(checkCycle.sourceFile, source);
  assert.equal(checkCycle.rootTransition.previousRoot, cycleBeforeRoot);
  assert.notEqual(checkCycle.rootTransition.currentRoot, cycleBeforeRoot);
  assert.equal(checkCycle.rootTransition.changed, true);
  assert.equal(checkCycle.capture.captured.length, 1);
  assert.equal(checkCycle.capture.captured[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");
  assert.equal(checkCycle.capture.captured[0].action, "added");
  assert.equal(checkCycle.capture.skipped.length, 0);
  assert.equal(checkCycle.projection.nodes.length, 1);
  assert.equal(checkCycle.projection.nodes[0].hash, checkCycle.capture.captured[0].hash);
  assert.equal(checkCycle.verification.ok, true);
  assert.equal(checkCycle.verification.checkedNodes, 1);
  assert.deepEqual(checkCycle.verification.diagnostics, []);
  assert.deepEqual(checkCycle.diagnostics, []);

  const repeatedCycle = run(["check-cycle", "--source", source, "--json"]);
  assert.equal(repeatedCycle.rootTransition.previousRoot, checkCycle.rootTransition.currentRoot);
  assert.equal(repeatedCycle.rootTransition.currentRoot, checkCycle.rootTransition.currentRoot);
  assert.equal(repeatedCycle.rootTransition.changed, false);
  assert.equal(repeatedCycle.capture.captured.length, 1);
  assert.equal(repeatedCycle.capture.captured[0].action, "unchanged");
  assert.equal(repeatedCycle.projection.nodes.length, 1);
  assert.equal(repeatedCycle.verification.ok, true);

  resetStorage();
  const previewPlan = tempJson("preview-plan.json", {
    schemaVersion: 1,
    mode: "plan",
    input: source,
    fixes: [
      {
        id: "make-binding-mutable",
        diagnosticCode: "TYP009",
        safety: "behavior-preserving",
        summary: "Synthetic preview repair.",
        hasPreview: true,
        edits: [
          {
            path: source,
            range: {
              start: { line: 2, column: 5 },
              end: { line: 2, column: 8 },
              columnUnit: "utf8-byte",
            },
            oldText: "let",
            newText: "let mut",
            precondition: { kind: "exact-text", text: "let" },
          },
        ],
      },
    ],
  });
  const previewCapture = run(["capture-fix-plan", "--source", source, "--fix-plan-json", previewPlan]);
  assert.equal(previewCapture.ok, true);
  assert.equal(previewCapture.captured.length, 1);
  assert.equal(previewCapture.captured[0].action, "added");
  assert.equal(previewCapture.captured[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");
  const previewRootPointer = readRootPointer();
  const previewRootSnapshot = readRootSnapshot(storage, previewRootPointer.currentRoot);
  const previewVerify = run(["verify", "--json"]);
  assert.equal(previewVerify.ok, true);
  assert.equal(previewVerify.nodes[0].preconditions[0].actual, "let");

  const lifecyclePlan = tempJson("lifecycle-plan.json", {
    schemaVersion: 1,
    mode: "plan",
    input: source,
    fixes: [
      {
        id: "make-binding-mutable",
        diagnosticCode: "TYP009",
        safety: "behavior-preserving",
        summary: "Changed lifecycle summary.",
        hasPreview: true,
        edits: [
          {
            path: source,
            range: {
              start: { line: 2, column: 5 },
              end: { line: 2, column: 8 },
              columnUnit: "utf8-byte",
            },
            oldText: "let",
            newText: "let mut",
            precondition: { kind: "exact-text", text: "let" },
          },
        ],
      },
    ],
  });
  const lifecycleCapture = run(["capture-fix-plan", "--source", source, "--fix-plan-json", lifecyclePlan]);
  assert.equal(lifecycleCapture.ok, true);
  assert.equal(lifecycleCapture.captured.length, 1);
  assert.equal(lifecycleCapture.captured[0].action, "superseded");
  assert.notEqual(lifecycleCapture.captured[0].hash, previewCapture.captured[0].hash);

  const lifecycleRootPointer = readRootPointer();
  assert.notEqual(lifecycleRootPointer.currentRoot, previewRootPointer.currentRoot);
  assert.equal(lifecycleRootPointer.previousRoot, previewRootPointer.currentRoot);
  const lifecycleRoot = readRootSnapshot(storage, lifecycleRootPointer.currentRoot);
  assert.equal(lifecycleRoot.parentRoot, previewRootPointer.currentRoot);
  assert.equal(lifecycleRoot.reason, "capture-fix-plan");
  assert.deepEqual(lifecycleRoot.nodes, [lifecycleCapture.captured[0].hash]);
  assert.deepEqual(lifecycleRoot.activeNodes, [lifecycleCapture.captured[0].hash]);
  assert.deepEqual(lifecycleRoot.supersededNodes, [previewCapture.captured[0].hash]);
  assert.equal(existsSync(snapshotPath(storage, previewRootPointer.currentRoot)), true);
  assert.deepEqual(previewRootSnapshot.activeNodes, [previewCapture.captured[0].hash]);
  const lifecycleIndex = JSON.parse(readFileSync(path.join(storage, "indexes/source-index.json"), "utf8"));
  assert.deepEqual(lifecycleIndex.sources[source], [lifecycleCapture.captured[0].hash]);

  const oldLifecycleNode = JSON.parse(readFileSync(path.join(storage, "nodes", `${previewCapture.captured[0].hash.replace("sha256:", "")}.json`), "utf8"));
  const newLifecycleNode = JSON.parse(readFileSync(path.join(storage, "nodes", `${lifecycleCapture.captured[0].hash.replace("sha256:", "")}.json`), "utf8"));
  assert.equal(oldLifecycleNode.lifecycle.state, "superseded");
  assert.equal(oldLifecycleNode.lifecycle.supersededBy, lifecycleCapture.captured[0].hash);
  assert.equal(newLifecycleNode.lifecycle.state, "active");
  assert.deepEqual(newLifecycleNode.parents, [previewCapture.captured[0].hash]);
  assert.deepEqual(newLifecycleNode.lifecycle.supersedes, [previewCapture.captured[0].hash]);

  const lifecycleProject = run(["project", "--source", source, "--json"]);
  assert.equal(lifecycleProject.nodes.length, 1);
  assert.equal(lifecycleProject.nodes[0].hash, lifecycleCapture.captured[0].hash);
  assert.equal(lifecycleProject.nodes[0].lifecycle.state, "active");
  const lifecycleProjectWithSuperseded = run(["project", "--source", source, "--json", "--include-superseded"]);
  assert.equal(lifecycleProjectWithSuperseded.nodes.length, 2);
  assert(lifecycleProjectWithSuperseded.nodes.some((node: any) => node.hash === previewCapture.captured[0].hash && node.lifecycle.state === "superseded"));
  const lifecycleVerify = run(["verify", "--json"]);
  assert.equal(lifecycleVerify.ok, true);
  assert.equal(lifecycleVerify.checkedNodes, 1);
  assert.equal(lifecycleVerify.nodes[0].lifecycle.state, "active");
  const lifecycleVerifyWithSuperseded = run(["verify", "--json", "--include-superseded"]);
  assert.equal(lifecycleVerifyWithSuperseded.ok, true);
  assert.equal(lifecycleVerifyWithSuperseded.checkedNodes, 2);
  assert(lifecycleVerifyWithSuperseded.nodes.some((node: any) => node.hash === previewCapture.captured[0].hash && node.lifecycle.state === "superseded"));

  const rootHistoryDiff = run(["diff", "--from", snapshotPath(storage, previewRootPointer.currentRoot), "--to", snapshotPath(storage, lifecycleRootPointer.currentRoot), "--json"]);
  assert.equal(rootHistoryDiff.ok, true);
  assert.equal(rootHistoryDiff.summary.changed, 1);
  assert.equal(rootHistoryDiff.summary.lifecycleChanged, 1);
  assert(rootHistoryDiff.nodes.lifecycleChanged.some((node: any) =>
    node.hash === previewCapture.captured[0].hash &&
    node.from.state === "active" &&
    node.to.state === "superseded"
  ));

  resetStorage();
  const noPreviewPlan = tempJson("no-preview-plan.json", {
    schemaVersion: 1,
    mode: "plan",
    input: source,
    fixes: [
      {
        id: "requires-human-review",
        diagnosticCode: "TYP999",
        safety: "requires-human-review",
        summary: "Synthetic no-preview repair.",
        hasPreview: false,
      },
    ],
  });
  const noPreviewCapture = run(["capture-fix-plan", "--source", source, "--fix-plan-json", noPreviewPlan]);
  assert.equal(noPreviewCapture.ok, true);
  assert.equal(noPreviewCapture.captured.length, 0);
  assert.equal(noPreviewCapture.skipped.length, 1);
  assert.equal(noPreviewCapture.skipped[0].reason, "no-preview");
  assert(noPreviewCapture.diagnostics.some((diagnostic: any) =>
    diagnostic.code === "CTX_FIX_PLAN_NO_PREVIEW" &&
    diagnostic.severity === "warning" &&
    diagnostic.nodeId === "ctx:repair-memory:typ999:requires-human-review"
  ));

  resetStorage();
  const malformedPlan = tempJson("malformed-plan.json", "{");
  const malformedCapture = run(["capture-fix-plan", "--source", source, "--fix-plan-json", malformedPlan], { allowFailure: true });
  assert.equal(malformedCapture.ok, false);
  assert.equal(malformedCapture.captured.length, 0);
  assert(malformedCapture.diagnostics.some((diagnostic: any) =>
    diagnostic.code === "CTX_FIX_PLAN_MALFORMED" &&
    diagnostic.severity === "error"
  ));

  resetStorage();
  const fixtureCapture = run(["capture-repair", "--source", source]);
  const fixtureProject = run(["project", "--source", source, "--json"]);
  resetStorage();
  const equivalentFixPlanCapture = run(["capture-fix-plan", "--source", source]);
  const equivalentFixPlanProject = run(["project", "--source", source, "--json"]);
  assert.equal(fixtureCapture.node.nodeId, equivalentFixPlanCapture.captured[0].nodeId);
  assert.equal(fixtureProject.nodes[0].diagnosticCode, equivalentFixPlanProject.nodes[0].diagnosticCode);
  assert.equal(fixtureProject.nodes[0].repairId, equivalentFixPlanProject.nodes[0].repairId);
  assert.deepEqual(fixtureProject.nodes[0].frontier, equivalentFixPlanProject.nodes[0].frontier);

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
    assert.deepEqual(identicalDiff.summary, { added: 0, removed: 0, changed: 0, unchanged: 1, lifecycleChanged: 0 });
    assert.equal(identicalDiff.nodes.unchanged[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");

    resetStorage(addedA);
    run(["init"], { storage: addedA });
    const addedCapture = captureContext(addedB);
    const addedDiff = run(["diff", "--from", addedA, "--to", addedB, "--json"]);
    assert.equal(addedDiff.ok, true);
    assert.deepEqual(addedDiff.summary, { added: 1, removed: 0, changed: 0, unchanged: 0, lifecycleChanged: 0 });
    assert.equal(addedDiff.nodes.added[0].hash, addedCapture.node.hash);

    const removedDiff = run(["diff", "--from", addedB, "--to", addedA, "--json"]);
    assert.equal(removedDiff.ok, true);
    assert.deepEqual(removedDiff.summary, { added: 0, removed: 1, changed: 0, unchanged: 0, lifecycleChanged: 0 });
    assert.equal(removedDiff.nodes.removed[0].hash, addedCapture.node.hash);

    captureContext(changedA);
    captureContext(changedB);
    const changedNode = mutateResidualSummary(changedB, "Changed residual summary for semantic diff testing.");
    const changedDiff = run(["diff", "--from", changedA, "--to", changedB, "--json"]);
    assert.equal(changedDiff.ok, true);
    assert.deepEqual(changedDiff.summary, { added: 0, removed: 0, changed: 1, unchanged: 0, lifecycleChanged: 0 });
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
