#!/usr/bin/env node

import { chmod, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  PRODUCT,
  RUNTIME_CONFIG,
  applyRuntimeStage,
  assertNotSymlink,
  assertSafeRuntimeTargets,
  assertSupportedRuntime,
  arraysEqual,
  atomicWrite,
  createBackups,
  createRuntimeSnapshot,
  enableHooksFeature,
  hashFile,
  inspectTopLevelNotify,
  inspectRuntimeConfig,
  installationPaths,
  mergePermissionHook,
  inspectNotifyChainRisk,
  parseArguments,
  pathExists,
  permissionHook,
  promptHiddenDeviceKey,
  prepareRuntimeStage,
  readDeviceKeyFromFile,
  readManifest,
  readTextIfPresent,
  removeLegacyRuntimeSnapshots,
  removePermissionHook,
  replaceTopLevelNotify,
  rewriteManagedNotifyChain,
  removeRuntimeTemporary,
  restoreRuntimeSnapshot,
  runtimeFileHashes,
  parseJsonObject,
} from "./lib/installer-core.mjs";

export const HELP = `Usage: node scripts/install.mjs [options]

Options:
  --dry-run          Inspect and print the planned changes without writing
  --key-file PATH    Read the Bark Device Key from a private file
  -h, --help         Show this help

Never pass a Bark key as a command-line value. Without --key-file, a hidden
interactive prompt is used.`;

function printPlan(plan) {
  console.log(`Codex home: ${plan.paths.codexHome}`);
  console.log(`Install root: ${plan.paths.installRoot}`);
  console.log(`notify mode: ${plan.notifyMode}`);
  console.log(`config.toml: ${plan.configChanged ? "update" : "unchanged"}`);
  console.log(`hooks.json: ${plan.hooksChanged ? "update" : "unchanged"}`);
  console.log(`Bark key: ${plan.keepExistingKey ? "keep existing" : "write privately"}`);
}

export async function buildInstallPlan({
  paths = installationPaths(),
  nodePath = process.execPath,
  existingManifest = null,
} = {}) {
  const configExisted = await pathExists(paths.configToml);
  const hooksExisted = await pathExists(paths.hooksJson);
  const configBefore = await readTextIfPresent(paths.configToml);
  const hooksBefore = await readTextIfPresent(paths.hooksJson);
  const notifyBefore = inspectTopLevelNotify(configBefore);

  if (existingManifest?.status === "installed") {
    for (const [file, expectedHash] of Object.entries(
      existingManifest.files ?? {},
    )) {
      if ((await pathExists(file)) && (await hashFile(file)) !== expectedHash) {
        throw new Error(
          `Managed runtime file was locally modified; refusing to overwrite it: ${file}`,
        );
      }
    }
  } else if (
    notifyBefore.exists &&
    inspectNotifyChainRisk(
      notifyBefore.value,
      [paths.entry, paths.dispatcher],
    )
  ) {
    throw new Error(
      "The existing notify chain references this install directory or cannot be safely inspected while installed.json is missing; refusing installation.",
    );
  }

  const previousNotify =
    existingManifest?.status === "installed"
      ? existingManifest.config.previousNotify
      : notifyBefore.exists
        ? notifyBefore.value
        : null;
  const previousNotifyAssignment =
    existingManifest?.status === "installed"
      ? existingManifest.config.previousNotifyAssignment
      : notifyBefore.exists
        ? notifyBefore.raw
        : "";
  const notifySeparatorAdded =
    existingManifest?.status === "installed"
      ? existingManifest.config.notifySeparatorAdded ?? ""
      : !notifyBefore.exists
        ? (() => {
            const body = configBefore.startsWith("\uFEFF")
              ? configBefore.slice(1)
              : configBefore;
            return body && !body.startsWith("\n") ? "\n" : "";
          })()
        : "";
  const notifyMode = previousNotify ? "dispatcher" : "direct";
  const managedNotify =
    notifyMode === "dispatcher"
      ? [nodePath, paths.dispatcher]
      : [nodePath, paths.entry];
  let configuredNotify = managedNotify;
  if (existingManifest?.status === "installed") {
    if (!notifyBefore.exists) {
      throw new Error(
        "The managed notify setting changed after installation; refusing to overwrite it.",
      );
    }
    const rewritten = rewriteManagedNotifyChain(
      notifyBefore.value,
      existingManifest.config.managedNotify,
      managedNotify,
      [paths.entry, paths.dispatcher],
    );
    if (!rewritten.matched || !rewritten.command) {
      throw new Error(
        "The managed notify setting changed after installation; refusing to overwrite it.",
      );
    }
    configuredNotify = rewritten.command;
  }
  const withNotify =
    notifyBefore.exists && arraysEqual(notifyBefore.value, configuredNotify)
      ? configBefore
      : replaceTopLevelNotify(configBefore, configuredNotify);
  const feature = enableHooksFeature(withNotify);
  const featureBefore =
    existingManifest?.status === "installed"
      ? existingManifest.config.hooksFeatureBefore
      : feature.before;

  const managedHook = permissionHook(nodePath, paths.entry);
  const hooksWithoutOldManaged =
    existingManifest?.status === "installed"
      ? removePermissionHook(
          hooksBefore,
          existingManifest.hooks.managedEntry,
          { fileExisted: true, permissionArrayExisted: true },
        )
      : hooksBefore;
  const hookMerge = mergePermissionHook(hooksWithoutOldManaged, managedHook);
  const hooksBeforeState =
    existingManifest?.status === "installed"
      ? existingManifest.hooks.before
      : hookMerge.before;

  return {
    paths,
    configExisted,
    hooksExisted,
    configBefore,
    hooksBefore,
    configAfter: feature.content,
    hooksAfter: hookMerge.content,
    configChanged: feature.content !== configBefore,
    hooksChanged: hookMerge.content !== hooksBefore,
    previousNotify,
    previousNotifyAssignment,
    notifySeparatorAdded,
    notifyMode,
    managedNotify,
    featureBefore,
    managedHook,
    hooksBeforeState,
    keepExistingKey: await pathExists(paths.key),
    existingManifest,
  };
}

export async function install({
  argv = process.argv.slice(2),
  paths = installationPaths(),
  runtime = {},
  input = process.stdin,
  output = process.stderr,
  operations = {},
} = {}) {
  assertSupportedRuntime(runtime);
  const options = parseArguments(argv, "install");
  if (options.help) {
    console.log(HELP);
    return { outcome: "help" };
  }

  await assertSafeRuntimeTargets(paths);
  await assertNotSymlink(paths.configToml, { requireFile: true });
  await assertNotSymlink(paths.hooksJson, { requireFile: true });
  const runtimeConfigState = await inspectRuntimeConfig(paths);
  const existingManifest = await readManifest(paths);
  const plan = await buildInstallPlan({ paths, existingManifest });
  printPlan(plan);
  if (options.dryRun) {
    console.log("Dry run complete; no files were changed and no key was read.");
    return { outcome: "dry-run", plan };
  }

  await removeLegacyRuntimeSnapshots(paths);

  let deviceKey = "";
  if (!plan.keepExistingKey) {
    deviceKey = options.keyFile
      ? await readDeviceKeyFromFile(options.keyFile, {
          packageRoot: paths.packageRoot,
        })
      : await promptHiddenDeviceKey({ input, output });
  }

  const stage = await prepareRuntimeStage(paths, {
    notifyMode: plan.notifyMode,
    previousNotify: plan.previousNotify,
    nodePath: process.execPath,
  });
  let backup;
  let snapshot;
  try {
    backup = await createBackups(paths, [
      paths.configToml,
      paths.hooksJson,
    ]);
    snapshot = await createRuntimeSnapshot(paths);
    await applyRuntimeStage(paths, stage);
    const writeAtomic = operations.atomicWrite ?? atomicWrite;
    if (!runtimeConfigState.exists) {
      const runtimeConfigSource = `${JSON.stringify(RUNTIME_CONFIG, null, 2)}\n`;
      parseJsonObject(runtimeConfigSource, "default config.json");
      await writeAtomic(paths.runtimeConfig, runtimeConfigSource, 0o600);
    } else {
      await chmod(paths.runtimeConfig, 0o600);
    }
    if (deviceKey) {
      await writeAtomic(paths.key, `${deviceKey}\n`, 0o600);
    } else {
      await chmod(paths.key, 0o600);
    }

    if (plan.configChanged || !plan.configExisted) {
      await writeAtomic(paths.configToml, plan.configAfter, 0o600);
    }
    if (plan.hooksChanged || !plan.hooksExisted) {
      parseJsonObject(plan.hooksAfter, "merged hooks.json");
      await writeAtomic(paths.hooksJson, plan.hooksAfter, 0o600);
    }

    const now = new Date().toISOString();
    const manifest = {
      product: PRODUCT,
      schemaVersion: 1,
      version: "0.1.0",
      status: "installed",
      installRoot: paths.installRoot,
      nodePath: process.execPath,
      installedAt:
        existingManifest?.status === "installed"
          ? existingManifest.installedAt
          : now,
      updatedAt: now,
      config: {
        path: paths.configToml,
        fileExisted:
          existingManifest?.status === "installed"
            ? existingManifest.config.fileExisted ?? true
            : plan.configExisted,
        notifyMode: plan.notifyMode,
        managedNotify: plan.managedNotify,
        previousNotify: plan.previousNotify,
        previousNotifyAssignment: plan.previousNotifyAssignment,
        notifySeparatorAdded: plan.notifySeparatorAdded,
        hooksFeatureBefore: plan.featureBefore,
      },
      hooks: {
        path: paths.hooksJson,
        managedEntry: plan.managedHook,
        before: plan.hooksBeforeState,
      },
      backups: [
        ...(existingManifest?.backups ?? []),
        backup,
      ],
      files: {},
    };
    manifest.files = await runtimeFileHashes(paths);
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    parseJsonObject(manifestSource, "installed.json");
    await writeAtomic(paths.manifest, manifestSource, 0o600);
    await removeRuntimeTemporary(stage, snapshot);
    console.log("Installed Codex Bark Notifier.");
    console.log(`Backup: ${backup.directory}`);
    console.log("Next: open Codex CLI, run /hooks, trust the PermissionRequest hook, then restart Codex Desktop.");
    return { outcome: "installed", manifest };
  } catch (error) {
    if (plan.hooksExisted) {
      await atomicWrite(paths.hooksJson, plan.hooksBefore, 0o600).catch(() => {});
    } else {
      await rm(paths.hooksJson, { force: true }).catch(() => {});
    }
    if (plan.configExisted) {
      await atomicWrite(paths.configToml, plan.configBefore, 0o600).catch(() => {});
    } else {
      await rm(paths.configToml, { force: true }).catch(() => {});
    }
    if (snapshot) {
      await restoreRuntimeSnapshot(paths, snapshot).catch(() => {});
    }
    await removeRuntimeTemporary(stage, snapshot).catch(() => {});
    throw error;
  }
}

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectExecution) {
  install().catch((error) => {
    console.error(`Installation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
