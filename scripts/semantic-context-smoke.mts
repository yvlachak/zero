#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const storage = path.join("/tmp", `zero-semantic-context-${process.pid}`);
const source = "conformance/native/fail/mem-copy-immutable-dst.0";

process.env.ZERO_CONTEXT_DIR = storage;
const { main } = await import("./semantic-context.mts");

function run(args: string[]): any {
  const originalLog = console.log;
  const priorExitCode = process.exitCode;
  let stdout = "";
  process.exitCode = undefined;
  console.log = (value?: unknown) => {
    stdout += `${String(value ?? "")}\n`;
  };
  try {
    main(args);
  } finally {
    console.log = originalLog;
  }
  assert.equal(process.exitCode ?? 0, 0);
  process.exitCode = priorExitCode;
  return JSON.parse(stdout);
}

try {
  rmSync(storage, { recursive: true, force: true });

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
  assert.deepEqual(verify.diagnostics, []);

  const nodeFile = path.join(storage, "nodes", `${capture.node.hash.replace("sha256:", "")}.json`);
  assert.equal(existsSync(nodeFile), true);
  const storedNode = JSON.parse(readFileSync(nodeFile, "utf8"));
  assert.equal(storedNode.hash, capture.node.hash);
  assert.match(storedNode.sourceAnchor.sourceHash, /^sha256:[0-9a-f]{64}$/);

  console.log("semantic context smoke ok");
} finally {
  rmSync(storage, { recursive: true, force: true });
}
