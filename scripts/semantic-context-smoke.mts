#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const storage = path.join("/tmp", `zero-semantic-context-${process.pid}`);
const fixtureDir = path.join("/tmp", `zero-semantic-context-fixtures-${process.pid}`);
const source = "conformance/native/fail/mem-copy-immutable-dst.0";

process.env.ZERO_CONTEXT_DIR = storage;
const { canonicalize, main, nodeHash, rootHashForSourceIndex, usageText } = await import("./semantic-context.mts");

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

function eventPath(dir: string, hash: string) {
  return path.join(dir, "events", `${hash.replace("sha256:", "")}.json`);
}

function nodePath(dir: string, hash: string) {
  return path.join(dir, "nodes", `${hash.replace("sha256:", "")}.json`);
}

function eventHash(event: any) {
  const { eventHash: _eventHash, ...payload } = event;
  return `sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}`;
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

  const usage = usageText();
  assert(usage.includes("semantic-context <command> [options]"));
  for (const command of ["init", "capture-repair", "capture-fix-plan", "capture-check", "capture-explain", "capture-graph", "project", "verify", "diff", "events", "timeline", "compliance", "policy", "reconcile", "check-cycle"]) {
    assert(usage.includes(command));
  }

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
  assert.match(checkCycle.event.eventHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(checkCycle.event.path, eventPath(storage, checkCycle.event.eventHash).split(path.sep).join("/"));
  assert.deepEqual(checkCycle.diagnostics, []);
  const checkCycleEvent = JSON.parse(readFileSync(eventPath(storage, checkCycle.event.eventHash), "utf8"));
  assert.equal(checkCycleEvent.schemaVersion, 1);
  assert.equal(checkCycleEvent.kind, "context-event");
  assert.match(checkCycleEvent.eventId, /^ctx:event:\d{6}$/);
  assert.equal(checkCycleEvent.eventHash, checkCycle.event.eventHash);
  assert.equal(checkCycleEvent.eventHash, eventHash(checkCycleEvent));
  assert.equal(checkCycleEvent.mode, "context-check-cycle");
  assert.equal(checkCycleEvent.sourceFile, source);
  assert.equal(checkCycleEvent.previousRoot, checkCycle.rootTransition.previousRoot);
  assert.equal(checkCycleEvent.currentRoot, checkCycle.rootTransition.currentRoot);
  assert.equal(checkCycleEvent.rootChanged, true);
  assert.deepEqual(checkCycleEvent.captured, [
    {
      nodeId: checkCycle.capture.captured[0].nodeId,
      hash: checkCycle.capture.captured[0].hash,
      action: "added",
    },
  ]);
  assert.deepEqual(checkCycleEvent.skipped, []);
  assert.deepEqual(checkCycleEvent.verification, { ok: true, checkedNodes: 1 });
  assert.deepEqual(checkCycleEvent.diagnostics, []);

  const repeatedCycle = run(["check-cycle", "--source", source, "--json"]);
  assert.equal(repeatedCycle.rootTransition.previousRoot, checkCycle.rootTransition.currentRoot);
  assert.equal(repeatedCycle.rootTransition.currentRoot, checkCycle.rootTransition.currentRoot);
  assert.equal(repeatedCycle.rootTransition.changed, false);
  assert.equal(repeatedCycle.capture.captured.length, 1);
  assert.equal(repeatedCycle.capture.captured[0].action, "unchanged");
  assert.equal(repeatedCycle.projection.nodes.length, 1);
  assert.equal(repeatedCycle.verification.ok, true);
  assert.match(repeatedCycle.event.eventHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(repeatedCycle.event.eventHash, checkCycle.event.eventHash);
  const repeatedCycleEvent = JSON.parse(readFileSync(eventPath(storage, repeatedCycle.event.eventHash), "utf8"));
  assert.equal(repeatedCycleEvent.eventHash, repeatedCycle.event.eventHash);
  assert.equal(repeatedCycleEvent.eventHash, eventHash(repeatedCycleEvent));
  assert.equal(repeatedCycleEvent.previousRoot, checkCycle.rootTransition.currentRoot);
  assert.equal(repeatedCycleEvent.currentRoot, checkCycle.rootTransition.currentRoot);
  assert.equal(repeatedCycleEvent.rootChanged, false);
  assert.deepEqual(repeatedCycleEvent.captured, [
    {
      nodeId: repeatedCycle.capture.captured[0].nodeId,
      hash: repeatedCycle.capture.captured[0].hash,
      action: "unchanged",
    },
  ]);

  const contextEvents = run(["events", "--json"]);
  assert.equal(contextEvents.schemaVersion, 1);
  assert.equal(contextEvents.mode, "context-events");
  assert.equal(contextEvents.events.length, 2);
  assert.deepEqual(contextEvents.diagnostics, []);
  assert(contextEvents.events.some((event: any) =>
    event.eventHash === checkCycle.event.eventHash &&
    event.previousRoot === checkCycle.rootTransition.previousRoot &&
    event.currentRoot === checkCycle.rootTransition.currentRoot &&
    event.rootChanged === true
  ));
  assert(contextEvents.events.some((event: any) =>
    event.eventHash === repeatedCycle.event.eventHash &&
    event.previousRoot === repeatedCycle.rootTransition.previousRoot &&
    event.currentRoot === repeatedCycle.rootTransition.currentRoot &&
    event.rootChanged === false
  ));

  const sourceTimeline = run(["timeline", "--source", source, "--json"]);
  assert.equal(sourceTimeline.schemaVersion, 1);
  assert.equal(sourceTimeline.mode, "context-timeline");
  assert.equal(sourceTimeline.sourceFile, source);
  assert.equal(sourceTimeline.events.length, 2);
  assert.equal(sourceTimeline.summary.events, 2);
  assert.equal(sourceTimeline.summary.rootTransitions, 1);
  assert.equal(sourceTimeline.summary.hashFailures, 0);
  assert.equal(sourceTimeline.summary.missingRoots, 0);
  assert.deepEqual(sourceTimeline.diagnostics, []);
  assert.equal(sourceTimeline.events[0].eventId, checkCycleEvent.eventId);
  assert.equal(sourceTimeline.events[0].eventHash, checkCycle.event.eventHash);
  assert.equal(sourceTimeline.events[0].eventHashOk, true);
  assert.equal(sourceTimeline.events[0].previousRootExists, true);
  assert.equal(sourceTimeline.events[0].currentRootExists, true);
  assert.equal(sourceTimeline.events[0].rootChanged, true);
  assert.deepEqual(sourceTimeline.events[0].captured, checkCycleEvent.captured);
  assert.deepEqual(sourceTimeline.events[0].verification, { ok: true, checkedNodes: 1 });
  assert.equal(sourceTimeline.events[1].eventHash, repeatedCycle.event.eventHash);
  assert.equal(sourceTimeline.events[1].eventHashOk, true);
  assert.equal(sourceTimeline.events[1].rootChanged, false);
  assert.equal(sourceTimeline.events[1].previousRootExists, true);
  assert.equal(sourceTimeline.events[1].currentRootExists, true);

  const allTimeline = run(["timeline", "--json"]);
  assert.equal(allTimeline.mode, "context-timeline");
  assert.equal(allTimeline.sourceFile, null);
  assert.equal(allTimeline.events.length, 2);
  assert.deepEqual(allTimeline.diagnostics, []);

  const compliance = run(["compliance", "--json"]);
  assert.equal(compliance.schemaVersion, 1);
  assert.equal(compliance.mode, "context-compliance");
  assert.equal(compliance.ok, true);
  assert.equal(compliance.scope.sourceFile, null);
  assert.equal(compliance.root.currentRoot, repeatedCycle.rootTransition.currentRoot);
  assert.equal(compliance.root.currentRootExists, true);
  assert.equal(compliance.root.rootHashOk, true);
  assert.equal(compliance.root.parentChainOk, true);
  assert.equal(compliance.root.rootDepth, 2);
  assert.equal(compliance.timeline.events, 2);
  assert.equal(compliance.timeline.eventHashesOk, true);
  assert.equal(compliance.timeline.rootReferencesOk, true);
  assert.equal(compliance.timeline.missingRoots, 0);
  assert.equal(compliance.timeline.hashFailures, 0);
  assert.equal(compliance.nodes.active, 1);
  assert.equal(compliance.nodes.superseded, 0);
  assert.equal(compliance.nodes.nodeHashesOk, true);
  assert.equal(compliance.nodes.lifecycleOk, true);
  assert.equal(compliance.anchors.checked, 1);
  assert.equal(compliance.anchors.ok, true);
  assert.equal(compliance.indexes.sourceIndexOk, true);
  assert.deepEqual(compliance.diagnostics, []);

  const sourceCompliance = run(["compliance", "--source", source, "--json"]);
  assert.equal(sourceCompliance.ok, true);
  assert.equal(sourceCompliance.scope.sourceFile, source);
  assert.equal(sourceCompliance.timeline.events, 2);
  assert.equal(sourceCompliance.anchors.checked, 1);
  assert.deepEqual(sourceCompliance.diagnostics, []);

  const advisoryPolicy = run(["policy", "--json"]);
  assert.equal(advisoryPolicy.schemaVersion, 1);
  assert.equal(advisoryPolicy.mode, "context-policy");
  assert.equal(advisoryPolicy.policy.mode, "advisory");
  assert.equal(advisoryPolicy.policy.ok, true);
  assert.equal(advisoryPolicy.policy.status, "advisory");
  assert.equal(advisoryPolicy.compliance.ok, true);
  assert.deepEqual(advisoryPolicy.diagnostics, []);

  const verifiedPolicy = run(["policy", "--policy", "verified", "--json"]);
  assert.equal(verifiedPolicy.policy.mode, "verified");
  assert.equal(verifiedPolicy.policy.ok, true);
  assert.equal(verifiedPolicy.policy.status, "verified");
  assert.equal(verifiedPolicy.compliance.ok, true);

  const strictPolicy = run(["policy", "--policy", "strict", "--json"]);
  assert.equal(strictPolicy.policy.mode, "strict");
  assert.equal(strictPolicy.policy.ok, true);
  assert.equal(strictPolicy.policy.status, "strict");
  assert.equal(strictPolicy.compliance.ok, true);

  const tamperedEvent = {
    ...checkCycleEvent,
    rootChanged: false,
  };
  writeFileSync(eventPath(storage, checkCycle.event.eventHash), `${JSON.stringify(tamperedEvent, null, 2)}\n`);
  rmSync(snapshotPath(storage, repeatedCycle.rootTransition.currentRoot), { force: true });
  const tamperedTimeline = run(["timeline", "--source", source, "--json"], { allowFailure: true });
  assert.equal(tamperedTimeline.events.length, 2);
  assert(tamperedTimeline.events.some((event: any) =>
    event.eventHash === checkCycle.event.eventHash &&
    event.eventHashOk === false
  ));
  assert(tamperedTimeline.events.some((event: any) =>
    event.eventHash === repeatedCycle.event.eventHash &&
    event.currentRootExists === false
  ));
  assert(tamperedTimeline.summary.hashFailures >= 1);
  assert(tamperedTimeline.summary.missingRoots >= 1);
  assert(tamperedTimeline.diagnostics.some((diagnostic: any) =>
    diagnostic.code === "CTX_TIMELINE_EVENT_HASH_MISMATCH" &&
    diagnostic.severity === "error"
  ));
  assert(tamperedTimeline.diagnostics.some((diagnostic: any) =>
    diagnostic.code === "CTX_TIMELINE_ROOT_MISSING" &&
    diagnostic.severity === "error"
  ));

  const missingRootDir = path.join("/tmp", `zero-semantic-context-missing-root-${process.pid}`);
  const tamperedEventDir = path.join("/tmp", `zero-semantic-context-tampered-event-${process.pid}`);
  const tamperedNodeDir = path.join("/tmp", `zero-semantic-context-tampered-node-${process.pid}`);
  const staleIndexDir = path.join("/tmp", `zero-semantic-context-stale-index-${process.pid}`);
  const strictCycleDir = path.join("/tmp", `zero-semantic-context-strict-cycle-${process.pid}`);
  const verifiedCycleDir = path.join("/tmp", `zero-semantic-context-verified-cycle-${process.pid}`);
  try {
    resetStorage(strictCycleDir);
    run(["init"], { storage: strictCycleDir });
    const strictCycle = run(["check-cycle", "--source", source, "--json", "--policy", "strict"], { storage: strictCycleDir });
    assert.equal(strictCycle.policy.mode, "strict");
    assert.equal(strictCycle.policy.ok, true);
    assert.equal(strictCycle.compliance.ok, true);
    assert.equal(strictCycle.compliance.anchors.ok, true);

    resetStorage(verifiedCycleDir);
    run(["init"], { storage: verifiedCycleDir });
    const verifiedCycle = run(["check-cycle", "--source", source, "--json", "--policy", "verified"], { storage: verifiedCycleDir });
    assert.equal(verifiedCycle.policy.mode, "verified");
    assert.equal(verifiedCycle.policy.ok, true);
    assert.equal(verifiedCycle.compliance.ok, true);

    resetStorage(missingRootDir);
    run(["init"], { storage: missingRootDir });
    const missingRootCycle = run(["check-cycle", "--source", source, "--json"], { storage: missingRootDir });
    rmSync(snapshotPath(missingRootDir, missingRootCycle.rootTransition.currentRoot), { force: true });
    const missingRootCompliance = run(["compliance", "--json"], { storage: missingRootDir, allowFailure: true });
    assert.equal(missingRootCompliance.ok, false);
    assert.equal(missingRootCompliance.root.currentRootExists, false);
    assert(missingRootCompliance.diagnostics.some((diagnostic: any) =>
      diagnostic.code === "CTX_COMPLIANCE_ROOT_SNAPSHOT_MISSING" &&
      diagnostic.severity === "error"
    ));

    resetStorage(tamperedEventDir);
    run(["init"], { storage: tamperedEventDir });
    const tamperedEventCycle = run(["check-cycle", "--source", source, "--json"], { storage: tamperedEventDir });
    const tamperedEventFile = eventPath(tamperedEventDir, tamperedEventCycle.event.eventHash);
    const complianceEvent = JSON.parse(readFileSync(tamperedEventFile, "utf8"));
    complianceEvent.rootChanged = false;
    writeFileSync(tamperedEventFile, `${JSON.stringify(complianceEvent, null, 2)}\n`);
    const tamperedEventCompliance = run(["compliance", "--json"], { storage: tamperedEventDir, allowFailure: true });
    assert.equal(tamperedEventCompliance.ok, false);
    assert.equal(tamperedEventCompliance.timeline.eventHashesOk, false);
    assert(tamperedEventCompliance.diagnostics.some((diagnostic: any) =>
      diagnostic.code === "CTX_COMPLIANCE_EVENT_HASH_MISMATCH" &&
      diagnostic.severity === "error"
    ));

    resetStorage(tamperedNodeDir);
    run(["init"], { storage: tamperedNodeDir });
    const tamperedNodeCycle = run(["check-cycle", "--source", source, "--json"], { storage: tamperedNodeDir });
    const tamperedNodeFile = nodePath(tamperedNodeDir, tamperedNodeCycle.capture.captured[0].hash);
    const complianceNode = JSON.parse(readFileSync(tamperedNodeFile, "utf8"));
    complianceNode.residualSummary = "Tampered residual summary.";
    writeFileSync(tamperedNodeFile, `${JSON.stringify(complianceNode, null, 2)}\n`);
    const tamperedNodeCompliance = run(["compliance", "--json"], { storage: tamperedNodeDir, allowFailure: true });
    assert.equal(tamperedNodeCompliance.ok, false);
    assert.equal(tamperedNodeCompliance.nodes.nodeHashesOk, false);
    assert(tamperedNodeCompliance.diagnostics.some((diagnostic: any) =>
      diagnostic.code === "CTX_COMPLIANCE_NODE_HASH_MISMATCH" &&
      diagnostic.severity === "error"
    ));

    resetStorage(staleIndexDir);
    run(["init"], { storage: staleIndexDir });
    run(["check-cycle", "--source", source, "--json"], { storage: staleIndexDir });
    const staleIndexPath = path.join(staleIndexDir, "indexes/source-index.json");
    const staleIndex = JSON.parse(readFileSync(staleIndexPath, "utf8"));
    staleIndex.sources[source] = ["sha256:0000000000000000000000000000000000000000000000000000000000000000"];
    writeFileSync(staleIndexPath, `${JSON.stringify(staleIndex, null, 2)}\n`);
    const staleIndexCompliance = run(["compliance", "--json"], { storage: staleIndexDir, allowFailure: true });
    assert.equal(staleIndexCompliance.ok, false);
    assert.equal(staleIndexCompliance.indexes.sourceIndexOk, false);
    assert(staleIndexCompliance.diagnostics.some((diagnostic: any) =>
      diagnostic.code === "CTX_COMPLIANCE_SOURCE_INDEX_STALE" &&
      diagnostic.severity === "error"
    ));
    const staleStrictPolicy = run(["policy", "--policy", "strict", "--json"], { storage: staleIndexDir, allowFailure: true });
    assert.equal(staleStrictPolicy.policy.mode, "strict");
    assert.equal(staleStrictPolicy.policy.ok, false);
    assert(staleStrictPolicy.diagnostics.some((diagnostic: any) =>
      diagnostic.code === "CTX_POLICY_STRICT_INDEX_FAILED" &&
      diagnostic.severity === "error"
    ));
    const staleAdvisoryPolicy = run(["policy", "--json"], { storage: staleIndexDir });
    assert.equal(staleAdvisoryPolicy.policy.mode, "advisory");
    assert.equal(staleAdvisoryPolicy.policy.ok, true);
    assert(staleAdvisoryPolicy.diagnostics.some((diagnostic: any) =>
      diagnostic.code === "CTX_COMPLIANCE_SOURCE_INDEX_STALE" &&
      diagnostic.severity === "error"
    ));
  } finally {
    for (const dir of [missingRootDir, tamperedEventDir, tamperedNodeDir, staleIndexDir, strictCycleDir, verifiedCycleDir]) resetStorage(dir);
  }

  const reconcileHappyDir = path.join("/tmp", `zero-semantic-context-reconcile-happy-${process.pid}`);
  const reconcileMismatchDir = path.join("/tmp", `zero-semantic-context-reconcile-mismatch-${process.pid}`);
  const reconcileArchiveDir = path.join("/tmp", `zero-semantic-context-reconcile-archive-${process.pid}`);
  const reconcileRefreshDir = path.join("/tmp", `zero-semantic-context-reconcile-refresh-${process.pid}`);
  const reconcileSupersedeDir = path.join("/tmp", `zero-semantic-context-reconcile-supersede-${process.pid}`);
  try {
    resetStorage(reconcileHappyDir);
    run(["init"], { storage: reconcileHappyDir });
    run(["check-cycle", "--source", source, "--json"], { storage: reconcileHappyDir });
    const happyReconcile = run(["reconcile", "--source", source, "--json"], { storage: reconcileHappyDir });
    assert.equal(happyReconcile.mode, "context-reconcile");
    assert.equal(happyReconcile.ok, true);
    assert.deepEqual(happyReconcile.actions, []);
    assert.deepEqual(happyReconcile.diagnostics, []);

    resetStorage(reconcileMismatchDir);
    const reconcileMismatchSource = tempFixture("reconcile-mismatch.0");
    const reconcileMismatchCapture = run(["capture-repair", "--source", reconcileMismatchSource], { storage: reconcileMismatchDir });
    let reconcileMismatchText = readFileSync(reconcileMismatchSource, "utf8");
    reconcileMismatchText = reconcileMismatchText.replace(/\blet\b/g, "var");
    writeFileSync(reconcileMismatchSource, reconcileMismatchText);
    const mismatchReconcile = run(["reconcile", "--source", reconcileMismatchSource, "--json"], { storage: reconcileMismatchDir, allowFailure: true });
    assert.equal(mismatchReconcile.ok, false);
    assert(mismatchReconcile.actions.some((action: any) =>
      action.hash === reconcileMismatchCapture.node.hash &&
      action.action === "refresh-anchor"
    ));
    assert(mismatchReconcile.diagnostics.some((diagnostic: any) =>
      diagnostic.code === "CTX_RECONCILE_SOURCE_VERIFY_FAILED" &&
      diagnostic.severity === "error"
    ));

    resetStorage(reconcileArchiveDir);
    const archiveCapture = run(["capture-repair", "--source", source], { storage: reconcileArchiveDir });
    const archiveBeforeRoot = readRootPointer(reconcileArchiveDir).currentRoot;
    const archiveReconcile = run(["reconcile", "--node", archiveCapture.node.hash, "--action", "archive", "--json"], { storage: reconcileArchiveDir });
    assert.equal(archiveReconcile.ok, true);
    assert.equal(archiveReconcile.action, "archive");
    assert.equal(archiveReconcile.node.lifecycle.state, "archived");
    assert.notEqual(archiveReconcile.rootTransition.currentRoot, archiveBeforeRoot);
    const archiveProject = run(["project", "--source", source, "--json"], { storage: reconcileArchiveDir });
    assert.deepEqual(archiveProject.nodes, []);
    const archivedNode = JSON.parse(readFileSync(nodePath(reconcileArchiveDir, archiveCapture.node.hash), "utf8"));
    assert.equal(archivedNode.lifecycle.state, "archived");
    const archiveRoot = readRootSnapshot(reconcileArchiveDir);
    assert.deepEqual(archiveRoot.activeNodes, []);
    assert.deepEqual(archiveRoot.archivedNodes, [archiveCapture.node.hash]);
    const archiveEvents = run(["events", "--json"], { storage: reconcileArchiveDir });
    assert(archiveEvents.events.some((event: any) =>
      event.eventHash === archiveReconcile.event.eventHash &&
      event.mode === "context-reconcile"
    ));

    resetStorage(reconcileRefreshDir);
    const refreshSource = tempFixture("reconcile-refresh.0");
    const refreshCapture = run(["capture-repair", "--source", refreshSource], { storage: reconcileRefreshDir });
    let refreshText = readFileSync(refreshSource, "utf8");
    refreshText = refreshText.replace(/\blet\b/g, "var");
    refreshText = refreshText.replace("    check world.out.write", "    let relocated = 1\n    check world.out.write");
    writeFileSync(refreshSource, refreshText);
    const refreshBeforeRoot = readRootPointer(reconcileRefreshDir).currentRoot;
    const refreshReconcile = run(["reconcile", "--node", refreshCapture.node.hash, "--action", "refresh-anchor", "--json"], { storage: reconcileRefreshDir });
    assert.equal(refreshReconcile.ok, true);
    assert.equal(refreshReconcile.action, "refresh-anchor");
    assert.notEqual(refreshReconcile.node.hash, refreshCapture.node.hash);
    assert.deepEqual(refreshReconcile.node.parents, [refreshCapture.node.hash]);
    assert.equal(refreshReconcile.node.sourceAnchor.range.start.line, 5);
    assert.notEqual(refreshReconcile.rootTransition.currentRoot, refreshBeforeRoot);
    const refreshedOldNode = JSON.parse(readFileSync(nodePath(reconcileRefreshDir, refreshCapture.node.hash), "utf8"));
    assert.equal(refreshedOldNode.lifecycle.state, "superseded");
    assert.equal(refreshedOldNode.lifecycle.supersededBy, refreshReconcile.node.hash);
    const refreshRoot = readRootSnapshot(reconcileRefreshDir);
    assert.deepEqual(refreshRoot.activeNodes, [refreshReconcile.node.hash]);
    assert.deepEqual(refreshRoot.supersededNodes, [refreshCapture.node.hash]);
    const refreshEvents = run(["events", "--json"], { storage: reconcileRefreshDir });
    assert(refreshEvents.events.some((event: any) => event.mode === "context-reconcile"));

    resetStorage(reconcileSupersedeDir);
    const supersedeCapture = run(["capture-repair", "--source", source], { storage: reconcileSupersedeDir });
    const supersedeBeforeRoot = readRootPointer(reconcileSupersedeDir).currentRoot;
    const supersedeReconcile = run(["reconcile", "--node", supersedeCapture.node.hash, "--action", "supersede", "--summary", "Updated reconcile summary.", "--json"], { storage: reconcileSupersedeDir });
    assert.equal(supersedeReconcile.ok, true);
    assert.equal(supersedeReconcile.action, "supersede");
    assert.notEqual(supersedeReconcile.node.hash, supersedeCapture.node.hash);
    assert.equal(supersedeReconcile.node.residualSummary, "Updated reconcile summary.");
    assert.deepEqual(supersedeReconcile.node.parents, [supersedeCapture.node.hash]);
    assert.notEqual(supersedeReconcile.rootTransition.currentRoot, supersedeBeforeRoot);
    const supersedeProject = run(["project", "--source", source, "--json"], { storage: reconcileSupersedeDir });
    assert.equal(supersedeProject.nodes.length, 1);
    assert.equal(supersedeProject.nodes[0].hash, supersedeReconcile.node.hash);
    const supersedeRoot = readRootSnapshot(reconcileSupersedeDir);
    assert.deepEqual(supersedeRoot.activeNodes, [supersedeReconcile.node.hash]);
    assert.deepEqual(supersedeRoot.supersededNodes, [supersedeCapture.node.hash]);
    const supersedeEvents = run(["events", "--json"], { storage: reconcileSupersedeDir });
    assert(supersedeEvents.events.some((event: any) => event.mode === "context-reconcile"));
  } finally {
    for (const dir of [reconcileHappyDir, reconcileMismatchDir, reconcileArchiveDir, reconcileRefreshDir, reconcileSupersedeDir]) resetStorage(dir);
  }

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
  run(["init"]);
  const generalizedCheckCapture = run(["capture-check", "--source", source, "--json"]);
  assert.equal(generalizedCheckCapture.ok, true);
  assert.equal(generalizedCheckCapture.mode, "context-capture-check");
  assert.equal(generalizedCheckCapture.captured.length, 1);
  assert.equal(generalizedCheckCapture.captured[0].kind, "diagnostic-memory");
  assert.equal(generalizedCheckCapture.captured[0].diagnosticCode, "TYP009");

  const generalizedRepairCapture = run(["capture-fix-plan", "--source", source]);
  assert.equal(generalizedRepairCapture.ok, true);
  assert.equal(generalizedRepairCapture.captured[0].nodeId, "ctx:repair-memory:typ009:make-binding-mutable");

  const generalizedExplainCapture = run(["capture-explain", "--code", "TYP009", "--json"]);
  assert.equal(generalizedExplainCapture.ok, true);
  assert.equal(generalizedExplainCapture.mode, "context-capture-explain");
  assert.equal(generalizedExplainCapture.captured.length, 1);
  assert.equal(generalizedExplainCapture.captured[0].kind, "explain-residual");
  assert.equal(generalizedExplainCapture.captured[0].diagnosticCode, "TYP009");

  const generalizedGraphCapture = run(["capture-graph", "--source", source, "--json"]);
  assert.equal(generalizedGraphCapture.ok, true);
  assert.equal(generalizedGraphCapture.mode, "context-capture-graph");
  assert.equal(generalizedGraphCapture.captured.length, 1);
  assert.equal(generalizedGraphCapture.captured[0].kind, "graph-context");

  const generalizedProject = run(["project", "--source", source, "--json"]);
  const projectedKinds = generalizedProject.nodes.map((node: any) => node.kind).sort();
  assert(projectedKinds.includes("diagnostic-memory"));
  assert(projectedKinds.includes("graph-context"));
  assert(projectedKinds.includes("repair-memory"));
  const generalizedCompliance = run(["compliance", "--json"]);
  assert.equal(generalizedCompliance.ok, true);
  assert.equal(generalizedCompliance.nodes.active, 4);

  const generalizedEmptyDir = path.join("/tmp", `zero-semantic-context-generalized-empty-${process.pid}`);
  const generalizedFullDir = path.join("/tmp", `zero-semantic-context-generalized-full-${process.pid}`);
  try {
    resetStorage(generalizedEmptyDir);
    run(["init"], { storage: generalizedEmptyDir });
    resetStorage(generalizedFullDir);
    run(["init"], { storage: generalizedFullDir });
    run(["capture-check", "--source", source, "--json"], { storage: generalizedFullDir });
    run(["capture-fix-plan", "--source", source], { storage: generalizedFullDir });
    run(["capture-explain", "--code", "TYP009", "--json"], { storage: generalizedFullDir });
    run(["capture-graph", "--source", source, "--json"], { storage: generalizedFullDir });
    const generalizedDiff = run(["diff", "--from", generalizedEmptyDir, "--to", generalizedFullDir, "--json"]);
    assert.equal(generalizedDiff.ok, true);
    assert(generalizedDiff.summary.added >= 4);
    assert(generalizedDiff.nodes.added.some((node: any) => node.kind === "diagnostic-memory"));
    assert(generalizedDiff.nodes.added.some((node: any) => node.kind === "explain-residual"));
    assert(generalizedDiff.nodes.added.some((node: any) => node.kind === "graph-context"));
  } finally {
    resetStorage(generalizedEmptyDir);
    resetStorage(generalizedFullDir);
  }

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
