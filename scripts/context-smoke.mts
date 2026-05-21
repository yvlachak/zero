import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cc = process.env.CC ?? "cc";
const out = `/tmp/zero-context-smoke-${process.pid}`;

try {
  await execFileAsync(cc, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-I",
    "native/zero-c/include",
    "-I",
    "native/zero-c/src",
    "native/zero-c/src/context.c",
    "native/zero-c/src/hash.c",
    "native/zero-c/src/fs.c",
    "native/zero-c/src/target.c",
    "native/zero-c/tests/context_smoke.c",
    "-o",
    out,
  ]);
  const result = await execFileAsync(out);
  process.stdout.write(result.stdout);
  if (!result.stdout.includes("context smoke ok")) {
    throw new Error(`unexpected context smoke output: ${result.stdout}`);
  }
} finally {
  await rm(out, { force: true });
}
