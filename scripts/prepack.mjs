import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function canExecute(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

function resolveBunPath() {
  const candidates = [
    process.env.BUN_BIN,
    "bun",
    path.join(os.homedir(), ".bun", "bin", "bun"),
    path.join(os.homedir(), ".bun", "bin", "bun.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (canExecute(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Bun is required for prepack. Install from https://bun.sh and ensure bun is available.",
  );
}

const bunPath = resolveBunPath();
const buildSteps = [
  ["run", "--cwd", "packages/contracts", "build"],
  ["run", "--cwd", "apps/renderer", "build"],
  ["run", "--cwd", "apps/t3", "build"],
];

for (const step of buildSteps) {
  const result = spawnSync(bunPath, step, {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
