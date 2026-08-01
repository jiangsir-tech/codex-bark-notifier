#!/usr/bin/env node

import { chmod, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  UnsafeManifestError,
  UnsafePathError,
  acquireLifecycleLock,
  assertNotSymlink,
  assertSafePrivateRoot,
  assertSafePrivateRoots,
  assertSafeRuntimeTargets,
  arraysEqual,
  assertSupportedRuntime,
  atomicWrite,
  assertTextFileUnchanged,
  cleanupRuntimeEphemera,
  createRuntimeSnapshot,
  captureTextFileState,
  expectedTextFileState,
  inspectTopLevelNotify,
  installationPaths,
  legacyRuntimeSnapshotPaths,
  parseArguments,
  pathExists,
  readManifest,
  releaseLifecycleLock,
  removeManagedRuntimeFiles,
  removeLegacyRuntimeSnapshots,
  removePermissionHook,
  removeTopLevelNotify,
  replaceTopLevelNotify,
  replaceTopLevelNotifyRaw,
  removeRuntimeTemporary,
  restoreRuntimeSnapshot,
  restoreHooksFeature,
  rollbackTextFileMutation,
  rewriteManagedNotifyChain,
} from "./lib/installer-core.mjs";

export const HELP = `Usage: node scripts/uninstall.mjs [options]

Options:
  --dry-run    Inspect and print the planned changes without writing
  --purge      Also delete the saved Bark key, audit log, state, and backups
  -h, --help   Show this help

Without --purge, the private Bark key, audit log, and backups are preserved.`;

export class UnsafeRestorePlanError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "UnsafeRestorePlanError";
    this.code = "CODEX_BARK_UNSAFE_RESTORE_PLAN";
  }
}

export async function buildUninstallPlan({
  paths = installationPaths(),
  manifest,
} = {}) {
  if (!manifest) {
    throw new Error("Codex Bark Notifier is not installed.");
  }
  if (manifest.status === "uninstalled") {
    return {
      paths,
      manifest,
      alreadyUninstalled: true,
      configChanged: false,
      hooksChanged: false,
    };
  }

  const [configBeforeState, hooksBeforeStateFile] = await Promise.all([
    captureTextFileState(paths.configToml),
    captureTextFileState(paths.hooksJson),
  ]);
  const configBefore = configBeforeState.content;
  const hooksBefore = hooksBeforeStateFile.content;
  const configExisted = configBeforeState.exists;
  const hooksExisted = hooksBeforeStateFile.exists;
  try {
    const notify = inspectTopLevelNotify(configBefore);
    if (!notify.exists) {
      throw new UnsafeRestorePlanError(
        "The managed notify setting changed after installation; refusing a destructive restore.",
      );
    }

    const replacementNotify =
      manifest.config.notifyMode === "dispatcher"
        ? manifest.config.previousNotify
        : null;
    const rewritten = rewriteManagedNotifyChain(
      notify.value,
      manifest.config.managedNotify,
      replacementNotify,
      [paths.entry, paths.dispatcher],
    );
    if (!rewritten.matched) {
      throw new UnsafeRestorePlanError(
        "The managed notify setting changed after installation; refusing a destructive restore.",
      );
    }

    const directlyManaged = arraysEqual(
      notify.value,
      manifest.config.managedNotify,
    );
    let configAfter;
    if (
      manifest.config.notifyMode === "dispatcher" &&
      rewritten.command &&
      arraysEqual(rewritten.command, manifest.config.previousNotify) &&
      manifest.config.previousNotifyAssignment
    ) {
      configAfter = replaceTopLevelNotifyRaw(
        configBefore,
        manifest.config.previousNotifyAssignment,
      );
    } else if (!rewritten.command) {
      configAfter = removeTopLevelNotify(configBefore, {
        removeFollowingBlankLine:
          directlyManaged &&
          manifest.config.notifySeparatorAdded === "\n",
      });
    } else {
      configAfter = replaceTopLevelNotify(
        configBefore,
        rewritten.command,
      );
    }
    configAfter = restoreHooksFeature(
      configAfter,
      manifest.config.hooksFeatureBefore,
    );
    const hooksAfter = removePermissionHook(
      hooksBefore,
      manifest.hooks.managedEntry,
      manifest.hooks.before,
    );

    return {
      paths,
      manifest,
      alreadyUninstalled: false,
      configBefore,
      configBeforeState,
      configExisted,
      configAfter,
      configAfterState: expectedTextFileState(
        configAfter,
        !(manifest.config.fileExisted === false && !configAfter.trim()),
      ),
      hooksBefore,
      hooksBeforeStateFile,
      hooksExisted,
      hooksAfter,
      hooksAfterState: expectedTextFileState(
        hooksAfter,
        Boolean(hooksAfter),
      ),
      configChanged: configAfter !== configBefore,
      removeConfigFile:
        manifest.config.fileExisted === false && !configAfter.trim(),
      hooksChanged: hooksAfter !== hooksBefore,
    };
  } catch (error) {
    if (error instanceof UnsafeRestorePlanError) {
      throw error;
    }
    throw new UnsafeRestorePlanError(
      `Codex configuration cannot be safely restored: ${error.message}`,
      { cause: error },
    );
  }
}

async function purgeWithoutTrustedRestore({
  paths,
  options,
  operations,
  reason,
}) {
  const legacySnapshots = await legacyRuntimeSnapshotPaths(paths);
  if (options.dryRun) {
    console.log(
      "Would purge fixed private runtime, backups, and legacy rollback snapshots; Codex config and hooks would not be changed.",
    );
    return {
      outcome: "dry-run",
      configRestored: false,
      legacySnapshots: legacySnapshots.length,
    };
  }

  const purgeRemove = operations.purgeRemove ?? rm;
  await assertSafePrivateRoots(paths);
  try {
    await purgePrivateTargets({
      paths,
      legacySnapshots,
      purgeRemove,
    });
  } catch (error) {
    throw new Error(
      `Purge reached its irreversible deletion step and only partially completed: ${error.message}`,
      { cause: error },
    );
  }

  console.log(
    `Purged fixed private runtime, backups, and legacy rollback snapshots. Codex config and hooks were not changed because ${reason}.`,
  );
  return {
    outcome:
      reason === "installed.json was missing"
        ? "purged-orphaned-data"
        : "purged-without-config-restore",
    configRestored: false,
    legacySnapshots: legacySnapshots.length,
  };
}

async function purgePrivateTargets({
  paths,
  legacySnapshots,
  purgeRemove,
}) {
  const failures = [];
  for (const target of [
    { kind: "install", path: paths.installRoot },
    { kind: "backup", path: paths.backupRoot },
  ]) {
    try {
      await assertSafePrivateRoot(paths, target.kind);
      await purgeRemove(target.path, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      failures.push(
        new Error(`Could not purge ${target.kind} root: ${error.message}`, {
          cause: error,
        }),
      );
    }
  }
  for (const candidate of legacySnapshots) {
    try {
      await removeLegacyRuntimeSnapshots(paths, [candidate]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `${failures.length} private purge operation(s) failed.`,
    );
  }
}

export async function uninstall({
  argv = process.argv.slice(2),
  paths = installationPaths(),
  runtime = {},
  operations = {},
} = {}) {
  assertSupportedRuntime(runtime);
  const options = parseArguments(argv, "uninstall");
  if (options.help) {
    console.log(HELP);
    return { outcome: "help" };
  }
  const lifecycleLock = options.dryRun
    ? null
    : await acquireLifecycleLock(paths);
  try {
    if (options.purge) {
      await assertSafePrivateRoots(paths);
    } else {
      await assertSafeRuntimeTargets(paths);
    }
  let manifest;
  try {
    manifest = await readManifest(paths);
  } catch (error) {
    if (
      options.purge &&
      (
        error instanceof UnsafeManifestError ||
        error instanceof UnsafePathError
      )
    ) {
      return await purgeWithoutTrustedRestore({
        paths,
        options,
        operations,
        reason: "installed.json was invalid",
      });
    }
    throw error;
  }
  if (!manifest) {
    if (options.purge) {
      return await purgeWithoutTrustedRestore({
        paths,
        options,
        operations,
        reason: "installed.json was missing",
      });
    }
    throw new Error("Codex Bark Notifier is not installed.");
  }

  try {
    await assertNotSymlink(paths.configToml, { requireFile: true });
    await assertNotSymlink(paths.hooksJson, { requireFile: true });
  } catch (error) {
    if (options.purge && error instanceof UnsafePathError) {
      return await purgeWithoutTrustedRestore({
        paths,
        options,
        operations,
        reason: "the Codex configuration paths were unsafe to restore",
      });
    }
    throw error;
  }
  let plan;
  try {
    plan = await buildUninstallPlan({ paths, manifest });
  } catch (error) {
    if (options.purge && error instanceof UnsafeRestorePlanError) {
      return await purgeWithoutTrustedRestore({
        paths,
        options,
        operations,
        reason: "the current Codex configuration could not be safely restored",
      });
    }
    throw error;
  }
  console.log(`Install root: ${paths.installRoot}`);
  console.log(
    plan.alreadyUninstalled
      ? "Configuration is already uninstalled."
      : `config.toml: ${plan.configChanged ? "restore" : "unchanged"}; hooks.json: ${plan.hooksChanged ? "restore" : "unchanged"}`,
  );
  console.log(
    options.purge
      ? "Private key, log, state, and backups: purge"
      : "Private key, log, and backups: preserve",
  );
  if (options.dryRun) {
    console.log("Dry run complete; no files were changed.");
    return { outcome: "dry-run", plan };
  }

  const legacySnapshots = await legacyRuntimeSnapshotPaths(paths);
  if (!options.purge) {
    await removeLegacyRuntimeSnapshots(paths, legacySnapshots);
  }
  const snapshot = options.purge
    ? null
    : await createRuntimeSnapshot(paths);
  const writeAtomic = operations.atomicWrite ?? atomicWrite;
  let preservedModified = [];
  let purgeCommitted = false;
  let configMutationAttempted = false;
  let hooksMutationAttempted = false;
  try {
    if (!plan.alreadyUninstalled) {
      await assertTextFileUnchanged(
        paths.configToml,
        plan.configBeforeState,
        "config.toml",
      );
      await assertTextFileUnchanged(
        paths.hooksJson,
        plan.hooksBeforeStateFile,
        "hooks.json",
      );
    }
    if (!plan.alreadyUninstalled && plan.configChanged) {
      await assertTextFileUnchanged(
        paths.configToml,
        plan.configBeforeState,
        "config.toml",
      );
      configMutationAttempted = true;
      if (plan.removeConfigFile) {
        await rm(paths.configToml, { force: true });
      } else {
        await writeAtomic(paths.configToml, plan.configAfter, 0o600);
      }
    }
    if (!plan.alreadyUninstalled && plan.hooksChanged) {
      await assertTextFileUnchanged(
        paths.hooksJson,
        plan.hooksBeforeStateFile,
        "hooks.json",
      );
      hooksMutationAttempted = true;
      if (plan.hooksAfter) {
        await writeAtomic(paths.hooksJson, plan.hooksAfter, 0o600);
      } else {
        await rm(paths.hooksJson, { force: true });
      }
    }

    if (options.purge) {
      await assertSafePrivateRoots(paths);
      purgeCommitted = true;
      const purgeRemove = operations.purgeRemove ?? rm;
      await purgePrivateTargets({
        paths,
        legacySnapshots,
        purgeRemove,
      });
      await removeRuntimeTemporary(snapshot);
      console.log("Uninstalled and purged Codex Bark Notifier private data.");
      return { outcome: "purged" };
    }

    preservedModified = await removeManagedRuntimeFiles(paths, manifest);
    const updatedManifest = {
      ...manifest,
      status: "uninstalled",
      uninstalledAt: new Date().toISOString(),
      files: {},
      preservedModified,
    };
    await writeAtomic(
      paths.manifest,
      `${JSON.stringify(updatedManifest, null, 2)}\n`,
      0o600,
    );
    await chmod(paths.installRoot, 0o700);
  } catch (error) {
    const rollbackSkipped = [];
    if (!purgeCommitted && !plan.alreadyUninstalled) {
      if (hooksMutationAttempted) {
        const result = await rollbackTextFileMutation(
          paths.hooksJson,
          plan.hooksBeforeStateFile,
          plan.hooksAfterState,
        ).catch(() => "concurrent");
        if (result === "concurrent") rollbackSkipped.push("hooks.json");
      }
      if (configMutationAttempted) {
        const result = await rollbackTextFileMutation(
          paths.configToml,
          plan.configBeforeState,
          plan.configAfterState,
        ).catch(() => "concurrent");
        if (result === "concurrent") rollbackSkipped.push("config.toml");
      }
    }
    if (!purgeCommitted && snapshot) {
      await restoreRuntimeSnapshot(paths, snapshot).catch(() => {});
    }
    await removeRuntimeTemporary(snapshot).catch(() => {});
    if (purgeCommitted) {
      throw new Error(
        `Purge reached its irreversible deletion step and only partially completed: ${error.message}`,
        { cause: error },
      );
    }
    if (rollbackSkipped.length) {
      throw new Error(
        `${error.message} Rollback preserved concurrently changed ${rollbackSkipped.join(" and ")}.`,
        { cause: error },
      );
    }
    throw error;
  }

  let cleanupWarning = "";
  try {
    await (
      operations.cleanupRuntimeEphemera ?? cleanupRuntimeEphemera
    )(paths);
  } catch {
    cleanupWarning =
      "Temporary state or jobs could not be fully removed; run uninstall again or use --purge.";
    console.warn(cleanupWarning);
  }
  await removeRuntimeTemporary(snapshot);
  console.log("Uninstalled Codex Bark Notifier.");
  console.log(`Private key and audit log preserved in: ${paths.installRoot}`);
  console.log(`Backups preserved in: ${paths.backupRoot}`);
  if (preservedModified.length) {
    console.log(
      `Preserved ${preservedModified.length} locally modified managed file(s).`,
    );
  }
  return cleanupWarning
    ? { outcome: "uninstalled", preservedModified, cleanupWarning }
    : { outcome: "uninstalled", preservedModified };
  } finally {
    if (lifecycleLock) {
      await releaseLifecycleLock(lifecycleLock);
    }
  }
}

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectExecution) {
  uninstall().catch((error) => {
    console.error(`Uninstall failed: ${error.message}`);
    process.exitCode = 1;
  });
}
