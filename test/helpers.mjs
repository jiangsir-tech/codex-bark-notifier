import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function temporaryPaths() {
  const root = await mkdtemp(join(tmpdir(), "codex-bark-notifier-test-"));
  const runtimeRoot = join(root, "runtime");
  const codexHome = join(root, "codex-home");
  const sessionRoot = join(codexHome, "sessions");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(sessionRoot, { recursive: true });

  return {
    root,
    runtimeRoot,
    codexHome,
    entryPath: join(runtimeRoot, "bark-notify.mjs"),
    configFile: join(runtimeRoot, "config.json"),
    keyFile: join(runtimeRoot, "bark-device-key"),
    stateDirectory: join(runtimeRoot, "state"),
    stateCleanupStamp: join(runtimeRoot, "state", ".sent-cleanup"),
    stateCleanupLock: join(runtimeRoot, "state", ".sent-cleanup.lock"),
    jobsDirectory: join(runtimeRoot, "jobs"),
    auditLog: join(runtimeRoot, "bark-notify.log"),
    auditArchive: join(runtimeRoot, "bark-notify.log.1"),
    auditRotationLock: join(runtimeRoot, "bark-notify.log.rotate.lock"),
    sessionRoot,
    sessionIndex: join(codexHome, "session_index.jsonl"),
  };
}

export async function removeTemporaryPaths(paths) {
  await rm(paths.root, { recursive: true, force: true });
}

export function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
