import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the disclosure guard blocks synthetic leaks before a local Git push", () => {
  const result = spawnSync(
    process.env.PI_TEST_PYTHON || "python3",
    ["tests/test_public_repo_guard.py"],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
