import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { install } from "../scripts/install.mjs";
import {
  atomicWrite,
  createRuntimeSnapshot,
  dispatcherSource,
  enableHooksFeature,
  formatNotifyAssignment,
  inspectNotifyChainRisk,
  inspectTopLevelNotify,
  installationPaths,
  parseArguments,
  pathExists,
  prepareRuntimeStage,
  promptHiddenDeviceKey,
  readDeviceKeyFromFile,
  readManifest,
  removeRuntimeTemporary,
  replaceTopLevelNotify,
  rewriteManagedNotifyChain,
  restoreRuntimeSnapshot,
} from "../scripts/lib/installer-core.mjs";
import { uninstall } from "../scripts/uninstall.mjs";

const TEST_RUNTIME = Object.freeze({
  platform: "darwin",
  nodeVersion: "22.0.0",
});

async function fixture(t, { config, hooks } = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-bark-installer-test-"));
  const codexHome = join(root, "codex home # test");
  await writeFile(join(root, ".keep"), "");
  await mkdir(codexHome, { recursive: true });
  if (config !== undefined) {
    await writeFile(join(codexHome, "config.toml"), config);
  }
  if (hooks !== undefined) {
    await writeFile(join(codexHome, "hooks.json"), hooks);
  }
  const keyFile = join(root, "device-key");
  await writeFile(keyFile, "testDeviceKey123456\n", { mode: 0o600 });
  const paths = installationPaths({
    environment: { CODEX_HOME: codexHome },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, codexHome, keyFile, paths };
}

async function installFixture(context, argv = ["--key-file"]) {
  const actualArgv =
    argv.length === 1 && argv[0] === "--key-file"
      ? ["--key-file", context.keyFile]
      : argv;
  return install({
    argv: actualArgv,
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
}

function fileMode(metadata) {
  return metadata.mode & 0o777;
}

test("key inputs reject argv secrets and unsafe source files", async (t) => {
  const sentinel = `DO_NOT_PERSIST_${process.hrtime.bigint()}`;
  for (const argv of [
    [`--key=${sentinel}`],
    ["--key", sentinel],
    [sentinel],
  ]) {
    assert.throws(
      () => parseArguments(argv, "install"),
      (error) => {
        assert.match(error.message, /forbidden|unknown option/iu);
        assert.doesNotMatch(error.message, new RegExp(sentinel, "u"));
        return true;
      },
    );
  }

  const context = await fixture(t);
  assert.equal(
    await readDeviceKeyFromFile(context.keyFile, {
      packageRoot: context.paths.packageRoot,
    }),
    "testDeviceKey123456",
  );

  await chmod(context.keyFile, 0o644);
  await assert.rejects(
    readDeviceKeyFromFile(context.keyFile),
    /group or other users/u,
  );
  await chmod(context.keyFile, 0o600);

  const missingSentinel = join(
    context.root,
    `BARK_KEY_PATH_MUST_NOT_APPEAR_${process.hrtime.bigint()}`,
  );
  await assert.rejects(
    readDeviceKeyFromFile(missingSentinel),
    (error) => {
      assert.match(error.message, /Unable to open the Bark key source file/u);
      assert.doesNotMatch(error.message, /BARK_KEY_PATH_MUST_NOT_APPEAR/u);
      return true;
    },
  );

  const linkedKey = join(context.root, "linked-key");
  await symlink(context.keyFile, linkedKey);
  await assert.rejects(
    readDeviceKeyFromFile(linkedKey),
    /symbolic link/u,
  );

  const repository = join(context.root, "repository");
  const repositoryKey = join(repository, "private-key");
  await mkdir(repository);
  await writeFile(repositoryKey, "repositoryDeviceKey123\n", {
    mode: 0o600,
  });
  await assert.rejects(
    readDeviceKeyFromFile(repositoryKey, { packageRoot: repository }),
    /outside the project repository/u,
  );

  const repositoryAlias = join(context.root, "repository-alias");
  await symlink(repository, repositoryAlias);
  await assert.rejects(
    readDeviceKeyFromFile(join(repositoryAlias, "private-key"), {
      packageRoot: repository,
    }),
    /outside the project repository/u,
  );

  const hardLinkedRepositoryKey = join(context.root, "hard-linked-key");
  await link(repositoryKey, hardLinkedRepositoryKey);
  await assert.rejects(
    readDeviceKeyFromFile(hardLinkedRepositoryKey, {
      packageRoot: repository,
    }),
    /non-linked file/u,
  );
});

test("hidden interactive key input never echoes the secret", async () => {
  const secret = "hiddenDeviceKey123456";
  const rawModes = [];
  let outputText = "";
  const input = {
    isTTY: true,
    setRawMode(value) {
      rawModes.push(value);
    },
    resume() {},
    pause() {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(secret);
      yield Buffer.from("\n");
    },
  };
  const output = {
    isTTY: true,
    write(value) {
      outputText += value;
    },
  };
  assert.equal(
    await promptHiddenDeviceKey({ input, output }),
    secret,
  );
  assert.deepEqual(rawModes, [true, false]);
  assert.doesNotMatch(outputText, new RegExp(secret, "u"));
  assert.match(outputText, /input hidden/u);
});

test("hidden interactive key input accepts key and newline in one chunk", async () => {
  const secret = "singleChunkDeviceKey123456";
  const rawModes = [];
  let outputText = "";
  const input = {
    isTTY: true,
    setRawMode(value) {
      rawModes.push(value);
    },
    resume() {},
    pause() {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(`${secret}\n`);
    },
  };
  const output = {
    isTTY: true,
    write(value) {
      outputText += value;
    },
  };

  assert.equal(await promptHiddenDeviceKey({ input, output }), secret);
  assert.deepEqual(rawModes, [true, false]);
  assert.doesNotMatch(outputText, new RegExp(secret, "u"));
});

test("fresh install uses direct notify, private permissions, and preserves public config on default uninstall", async (t) => {
  const context = await fixture(t);
  const result = await installFixture(context);
  assert.equal(result.outcome, "installed");

  const config = await readFile(context.paths.configToml, "utf8");
  assert.deepEqual(inspectTopLevelNotify(config).value, [
    process.execPath,
    context.paths.entry,
  ]);
  assert.match(config, /\[features\]\nhooks = true/u);
  assert.equal(fileMode(await stat(context.paths.installRoot)), 0o700);
  assert.equal(fileMode(await stat(context.paths.entry)), 0o700);
  assert.equal(fileMode(await stat(context.paths.key)), 0o600);
  assert.equal(fileMode(await stat(context.paths.manifest)), 0o600);
  assert.equal(fileMode(await stat(context.paths.runtimeConfig)), 0o600);
  assert.deepEqual(
    JSON.parse(await readFile(context.paths.runtimeConfig, "utf8")),
    {
      bark: {
        endpoint: "https://api.day.app/push",
        icon:
          "https://raw.githubusercontent.com/jiangsir-tech/codex-bark-icon/c188b28641901dbc8b3497bf9d8a8222243ef811/codex-bark-icon.png",
        group: "Codex",
        sound: "minuet",
        requestTimeoutMilliseconds: 8_000,
      },
    },
  );
  const manifest = await readManifest(context.paths);
  assert.equal(Object.hasOwn(manifest.files, context.paths.runtimeConfig), false);

  await uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME });
  assert.equal(await pathExists(context.paths.configToml), false);
  assert.equal(await pathExists(context.paths.hooksJson), false);
  assert.equal(await pathExists(context.paths.entry), false);
  assert.equal(await pathExists(context.paths.key), true);
  assert.equal(await pathExists(context.paths.runtimeConfig), true);
  assert.equal((await readManifest(context.paths)).status, "uninstalled");
  await uninstall({
    argv: ["--purge"],
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(await pathExists(context.paths.backupRoot), false);
});

test("purge without a manifest removes fixed private data and legacy snapshots", async (t) => {
  const context = await fixture(t);
  const legacySnapshot = join(
    context.paths.installRoot,
    "..",
    "codex-bark.rollback-Ab12Cd",
  );
  await mkdir(context.paths.jobs, { recursive: true });
  await mkdir(context.paths.state, { recursive: true });
  await mkdir(context.paths.backupRoot, { recursive: true });
  await mkdir(legacySnapshot, { recursive: true });
  await writeFile(context.paths.key, "ORPHANED_DEVICE_KEY");
  await writeFile(context.paths.auditLog, "ORPHANED_AUDIT");
  await writeFile(join(context.paths.jobs, "job"), "ORPHANED_JOB");
  await writeFile(join(legacySnapshot, "bark-device-key"), "LEGACY_KEY");

  const result = await uninstall({
    argv: ["--purge"],
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
  assert.deepEqual(result, {
    outcome: "purged-orphaned-data",
    configRestored: false,
    legacySnapshots: 1,
  });
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(await pathExists(context.paths.backupRoot), false);
  assert.equal(await pathExists(legacySnapshot), false);
});

test("purge without a manifest reports partial deletion as irreversible", async (t) => {
  const context = await fixture(t);
  const legacySnapshot = join(
    context.paths.installRoot,
    "..",
    "codex-bark.rollback-Fail01",
  );
  await mkdir(context.paths.installRoot, { recursive: true });
  await mkdir(context.paths.backupRoot, { recursive: true });
  await mkdir(legacySnapshot, { recursive: true });
  await writeFile(context.paths.key, "ORPHANED_DEVICE_KEY");
  await writeFile(join(legacySnapshot, "legacy-private-data"), "PRIVATE");

  await assert.rejects(
    uninstall({
      argv: ["--purge"],
      paths: context.paths,
      runtime: TEST_RUNTIME,
      operations: {
        purgeRemove: async (path, options) => {
          if (path === context.paths.backupRoot) {
            throw new Error("injected orphan backup purge failure");
          }
          return rm(path, options);
        },
      },
    }),
    /irreversible deletion step.*partially completed/u,
  );
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(await pathExists(context.paths.backupRoot), true);
  assert.equal(await pathExists(legacySnapshot), false);
});

test("purge rejects ancestor symlinks for fixed runtime and backup paths", async (t) => {
  const runtimeContext = await fixture(t);
  const externalNotifications = join(
    runtimeContext.root,
    "external-notifications",
  );
  const externalRuntime = join(externalNotifications, "codex-bark");
  const runtimeSentinel = join(externalRuntime, "must-survive");
  await mkdir(externalRuntime, { recursive: true });
  await writeFile(runtimeSentinel, "safe");
  await symlink(
    externalNotifications,
    join(runtimeContext.codexHome, "notifications"),
  );

  await assert.rejects(
    uninstall({
      argv: ["--purge"],
      paths: runtimeContext.paths,
      runtime: TEST_RUNTIME,
    }),
    /canonical private path is unexpected/u,
  );
  assert.equal(await readFile(runtimeSentinel, "utf8"), "safe");

  const backupContext = await fixture(t);
  await mkdir(backupContext.paths.installRoot, { recursive: true });
  await writeFile(backupContext.paths.key, "ORPHANED_DEVICE_KEY");
  const externalBackups = join(backupContext.root, "external-backups");
  const externalBackupRoot = join(
    externalBackups,
    "codex-bark-notifier",
  );
  const backupSentinel = join(externalBackupRoot, "must-survive");
  await mkdir(externalBackupRoot, { recursive: true });
  await writeFile(backupSentinel, "safe");
  await symlink(
    externalBackups,
    join(backupContext.codexHome, "backups"),
  );

  await assert.rejects(
    uninstall({
      argv: ["--purge"],
      paths: backupContext.paths,
      runtime: TEST_RUNTIME,
    }),
    /canonical private path is unexpected/u,
  );
  assert.equal(
    await readFile(backupContext.paths.key, "utf8"),
    "ORPHANED_DEVICE_KEY",
  );
  assert.equal(await readFile(backupSentinel, "utf8"), "safe");
});

test("legacy rollback cleanup rejects symlinks without touching their target", async (t) => {
  const context = await fixture(t);
  const sentinelDirectory = join(context.root, "sentinel-directory");
  const sentinel = join(sentinelDirectory, "must-survive");
  const legacyLink = join(
    context.paths.installRoot,
    "..",
    "codex-bark.rollback-Zy98Xw",
  );
  await mkdir(join(context.paths.installRoot, ".."), { recursive: true });
  await mkdir(sentinelDirectory);
  await writeFile(sentinel, "safe");
  await symlink(sentinelDirectory, legacyLink);

  await assert.rejects(
    uninstall({
      argv: ["--purge"],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    /unsafe legacy rollback entry/u,
  );
  assert.equal(await readFile(sentinel, "utf8"), "safe");
  assert.equal((await lstat(legacyLink)).isSymbolicLink(), true);
});

test("existing notify is dispatched and restored without changing unrelated hooks", async (t) => {
  const originalConfig =
    'model = "gpt-test"\nnotify = ["/usr/bin/printf", "old"] # preserve formatting\n\n[features]\nother = true\n';
  const originalHooks = `${JSON.stringify(
    {
      description: "existing",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/bin/true" }] }],
      },
    },
    null,
    2,
  )}\n`;
  const context = await fixture(t, {
    config: originalConfig,
    hooks: originalHooks,
  });
  await installFixture(context);
  assert.deepEqual(
    inspectTopLevelNotify(
      await readFile(context.paths.configToml, "utf8"),
    ).value,
    [process.execPath, context.paths.dispatcher],
  );
  assert.deepEqual(
    JSON.parse(await readFile(context.paths.previousNotify, "utf8")),
    ["/usr/bin/printf", "old"],
  );
  assert.equal(fileMode(await stat(context.paths.dispatcher)), 0o700);
  assert.equal(fileMode(await stat(context.paths.previousNotify)), 0o600);
  const installedHooks = JSON.parse(
    await readFile(context.paths.hooksJson, "utf8"),
  );
  assert.equal(installedHooks.description, "existing");
  assert.equal(installedHooks.hooks.Stop.length, 1);

  await uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME });
  assert.equal(await readFile(context.paths.configToml, "utf8"), originalConfig);
  assert.deepEqual(
    JSON.parse(await readFile(context.paths.hooksJson, "utf8")),
    JSON.parse(originalHooks),
  );
});

test("managed notify chains rewrite only the exact nested notifier", () => {
  const managed = ["/opt/node", "/private/codex-bark/dispatcher.mjs"];
  const previous = ["/Applications/Wrapper", "turn-ended"];
  const forbiddenPaths = [
    "/private/codex-bark/notify.mjs",
    "/private/codex-bark/dispatcher.mjs",
  ];
  const selfWrapper = [
    ...previous,
    "--previous-notify",
    JSON.stringify(managed),
  ];
  assert.deepEqual(
    rewriteManagedNotifyChain(
      selfWrapper,
      managed,
      previous,
      forbiddenPaths,
    ),
    {
      matched: true,
      command: previous,
    },
  );

  const outer = [
    "/Applications/OtherWrapper",
    "turn-ended",
    "--previous-notify",
    JSON.stringify(managed),
    "--keep-this-option",
  ];
  assert.deepEqual(
    rewriteManagedNotifyChain(
      outer,
      managed,
      previous,
      forbiddenPaths,
    ),
    {
      matched: true,
      command: [
        "/Applications/OtherWrapper",
        "turn-ended",
        "--previous-notify",
        JSON.stringify(previous),
        "--keep-this-option",
      ],
    },
  );
  assert.deepEqual(
    rewriteManagedNotifyChain(
      ["/Applications/OtherWrapper", "turn-ended"],
      managed,
      previous,
      forbiddenPaths,
    ),
    {
      matched: false,
      command: ["/Applications/OtherWrapper", "turn-ended"],
    },
  );
  assert.deepEqual(
    rewriteManagedNotifyChain(
      [
        "/Applications/OtherWrapper",
        "--previous-notify",
        JSON.stringify(["/bin/false"]),
      ],
      managed,
      previous,
      forbiddenPaths,
    ),
    {
      matched: false,
      command: [
        "/Applications/OtherWrapper",
        "--previous-notify",
        JSON.stringify(["/bin/false"]),
      ],
    },
  );
  assert.deepEqual(
    rewriteManagedNotifyChain(
      [
        "/Applications/OtherWrapper",
        "--previous-notify",
        JSON.stringify(managed),
        "--previous-notify",
        JSON.stringify(previous),
      ],
      managed,
      previous,
      forbiddenPaths,
    ).matched,
    false,
  );
});

test("managed notify chains fail closed on runtime aliases and excessive depth", () => {
  const managed = ["/opt/node", "/private/codex-bark/dispatcher.mjs"];
  const previous = ["/usr/bin/printf", "old"];
  const forbiddenPaths = [
    "/private/codex-bark/notify.mjs",
    "/private/codex-bark/dispatcher.mjs",
  ];
  const wrap = (command, count) => {
    let current = command;
    for (let index = 0; index < count; index += 1) {
      current = [
        `/Applications/Wrapper-${index}`,
        "--previous-notify",
        JSON.stringify(current),
      ];
    }
    return current;
  };

  const runtimeWrapper = [
    "/private/codex-bark/dispatcher.mjs",
    "--previous-notify",
    JSON.stringify(managed),
  ];
  assert.deepEqual(
    rewriteManagedNotifyChain(
      runtimeWrapper,
      managed,
      previous,
      forbiddenPaths,
    ),
    {
      matched: false,
      command: runtimeWrapper,
      unsafe: true,
      reason: "managed-runtime-reference",
    },
  );
  const aliasedRuntimeWrapper = [
    "/private/codex-bark/../codex-bark/dispatcher.mjs",
    "--previous-notify",
    JSON.stringify(managed),
  ];
  assert.deepEqual(
    rewriteManagedNotifyChain(
      aliasedRuntimeWrapper,
      managed,
      previous,
      forbiddenPaths,
    ),
    {
      matched: false,
      command: aliasedRuntimeWrapper,
      unsafe: true,
      reason: "managed-runtime-reference",
    },
  );
  assert.equal(
    inspectNotifyChainRisk(
      ["/private/codex-bark/../codex-bark/dispatcher.mjs"],
      forbiddenPaths,
    ),
    "managed-runtime-reference",
  );

  const maximumSupported = wrap(managed, 8);
  assert.equal(
    rewriteManagedNotifyChain(
      maximumSupported,
      managed,
      previous,
      forbiddenPaths,
    ).matched,
    true,
  );
  const tooDeep = wrap(managed, 9);
  assert.deepEqual(
    rewriteManagedNotifyChain(
      tooDeep,
      managed,
      previous,
      forbiddenPaths,
    ),
    {
      matched: false,
      command: tooDeep,
      unsafe: true,
      reason: "notify-chain-too-deep",
    },
  );

  assert.equal(
    inspectNotifyChainRisk(wrap(["/bin/true"], 8), forbiddenPaths),
    null,
  );
  assert.equal(
    inspectNotifyChainRisk(wrap(["/bin/true"], 9), forbiddenPaths),
    "notify-chain-too-deep",
  );
});

test("upgrade and uninstall support an external wrapper around the managed notifier", async (t) => {
  const previousNotify = ["/Applications/Wrapper", "turn-ended"];
  const originalConfig =
    `model = "gpt-test"\nnotify = ${JSON.stringify(previousNotify)} # preserve formatting\n\n[features]\nother = true\n`;
  const context = await fixture(t, {
    config: originalConfig,
    hooks: '{"hooks":{}}\n',
  });
  await installFixture(context);
  const firstManifest = await readManifest(context.paths);
  const wrappedNotify = [
    ...previousNotify,
    "--previous-notify",
    JSON.stringify(firstManifest.config.managedNotify),
  ];
  const wrappedConfig = replaceTopLevelNotify(
    await readFile(context.paths.configToml, "utf8"),
    wrappedNotify,
  );
  await writeFile(context.paths.configToml, wrappedConfig);

  const manifestBeforeDryRuns = await readFile(
    context.paths.manifest,
    "utf8",
  );
  assert.equal(
    (
      await install({
        argv: ["--dry-run"],
        paths: context.paths,
        runtime: TEST_RUNTIME,
      })
    ).outcome,
    "dry-run",
  );
  assert.equal(
    (
      await uninstall({
        argv: ["--dry-run"],
        paths: context.paths,
        runtime: TEST_RUNTIME,
      })
    ).outcome,
    "dry-run",
  );
  assert.equal(
    await readFile(context.paths.configToml, "utf8"),
    wrappedConfig,
  );
  assert.equal(
    await readFile(context.paths.manifest, "utf8"),
    manifestBeforeDryRuns,
  );

  await installFixture(context);
  assert.deepEqual(
    inspectTopLevelNotify(
      await readFile(context.paths.configToml, "utf8"),
    ).value,
    wrappedNotify,
  );

  await uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME });
  assert.equal(await readFile(context.paths.configToml, "utf8"), originalConfig);
});

test("uninstall preserves a different external wrapper and reconnects its previous notifier", async (t) => {
  const previousNotify = ["/usr/bin/printf", "old"];
  const context = await fixture(t, {
    config: `notify = ${JSON.stringify(previousNotify)}\n`,
    hooks: '{"hooks":{}}\n',
  });
  await installFixture(context);
  const manifest = await readManifest(context.paths);
  const outerBase = ["/Applications/OtherWrapper", "turn-ended", "--verbose"];
  const wrappedNotify = [
    outerBase[0],
    outerBase[1],
    "--previous-notify",
    JSON.stringify(manifest.config.managedNotify),
    outerBase[2],
  ];
  await writeFile(
    context.paths.configToml,
    replaceTopLevelNotify(
      await readFile(context.paths.configToml, "utf8"),
      wrappedNotify,
    ),
  );

  await uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME });
  assert.deepEqual(
    inspectTopLevelNotify(
      await readFile(context.paths.configToml, "utf8"),
    ).value,
    [
      outerBase[0],
      outerBase[1],
      "--previous-notify",
      JSON.stringify(previousNotify),
      outerBase[2],
    ],
  );
});

test("missing manifest rejects a managed notifier hidden inside a previous-notify wrapper", async (t) => {
  const context = await fixture(t);
  const wrappedNotify = [
    "/Applications/OtherWrapper",
    "turn-ended",
    "--previous-notify",
    JSON.stringify([process.execPath, context.paths.entry]),
  ];
  const originalConfig = `notify = ${JSON.stringify(wrappedNotify)}\n`;
  await writeFile(
    context.paths.configToml,
    originalConfig,
  );

  await assert.rejects(
    install({
      argv: ["--dry-run"],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    /installed\.json is missing.*refusing installation/u,
  );
  assert.equal(
    await readFile(context.paths.configToml, "utf8"),
    originalConfig,
  );
  assert.equal(await pathExists(context.paths.installRoot), false);
});

test("missing manifest rejects an over-deep previous-notify chain without writing", async (t) => {
  const context = await fixture(t);
  let wrappedNotify = [process.execPath, context.paths.entry];
  for (let index = 0; index < 9; index += 1) {
    wrappedNotify = [
      `/Applications/Wrapper-${index}`,
      "--previous-notify",
      JSON.stringify(wrappedNotify),
    ];
  }
  const originalConfig = `notify = ${JSON.stringify(wrappedNotify)}\n`;
  await writeFile(context.paths.configToml, originalConfig);

  await assert.rejects(
    install({
      argv: ["--dry-run"],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    /installed\.json is missing.*refusing installation/u,
  );
  assert.equal(
    await readFile(context.paths.configToml, "utf8"),
    originalConfig,
  );
  assert.equal(await pathExists(context.paths.installRoot), false);
});

test("missing manifest rejects a lexical alias of the managed runtime without writing", async (t) => {
  const context = await fixture(t);
  const aliasedEntry =
    `${context.paths.installRoot}/../codex-bark/bark-notify.mjs`;
  const originalConfig =
    `notify = ${JSON.stringify([process.execPath, aliasedEntry])}\n`;
  await writeFile(context.paths.configToml, originalConfig);

  await assert.rejects(
    install({
      argv: ["--dry-run"],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    /installed\.json is missing.*refusing installation/u,
  );
  assert.equal(
    await readFile(context.paths.configToml, "utf8"),
    originalConfig,
  );
  assert.equal(await pathExists(context.paths.installRoot), false);
});

test("manifest validation rejects a recursive notifier hidden inside its previous chain", async (t) => {
  const context = await fixture(t, {
    config: 'notify = ["/usr/bin/printf", "old"]\n',
  });
  await installFixture(context);
  const manifest = JSON.parse(
    await readFile(context.paths.manifest, "utf8"),
  );
  const recursivePrevious = [
    "/Applications/OtherWrapper",
    "--previous-notify",
    JSON.stringify(manifest.config.managedNotify),
  ];
  manifest.config.previousNotify = recursivePrevious;
  manifest.config.previousNotifyAssignment =
    formatNotifyAssignment(recursivePrevious);
  await writeFile(
    context.paths.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await assert.rejects(
    readManifest(context.paths),
    /recursive previous notifier/u,
  );
});

test("manifest validation accepts the chain limit and rejects one level beyond it", async (t) => {
  const context = await fixture(t, {
    config: 'notify = ["/usr/bin/printf", "old"]\n',
  });
  await installFixture(context);
  const manifest = JSON.parse(
    await readFile(context.paths.manifest, "utf8"),
  );
  const wrap = (count) => {
    let current = ["/usr/bin/printf", "old"];
    for (let index = 0; index < count; index += 1) {
      current = [
        `/Applications/Wrapper-${index}`,
        "--previous-notify",
        JSON.stringify(current),
      ];
    }
    return current;
  };

  const maximumSupported = wrap(8);
  manifest.config.previousNotify = maximumSupported;
  manifest.config.previousNotifyAssignment =
    formatNotifyAssignment(maximumSupported);
  await writeFile(
    context.paths.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  assert.deepEqual(
    (await readManifest(context.paths)).config.previousNotify,
    maximumSupported,
  );

  const tooDeep = wrap(9);
  manifest.config.previousNotify = tooDeep;
  manifest.config.previousNotifyAssignment =
    formatNotifyAssignment(tooDeep);
  await writeFile(
    context.paths.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await assert.rejects(
    readManifest(context.paths),
    /recursive previous notifier/u,
  );
});

test("dispatcher staging never writes previous notifier arguments to temporary storage", async (t) => {
  const context = await fixture(t);
  const sentinel = "PREVIOUS_NOTIFIER_SECRET_MUST_NOT_BE_STAGED";
  const stage = await prepareRuntimeStage(context.paths, {
    notifyMode: "dispatcher",
    previousNotify: ["/usr/bin/printf", sentinel],
    nodePath: process.execPath,
  });
  t.after(() => removeRuntimeTemporary(stage));

  const stagedEntries = await readdir(stage.root, { recursive: true });
  assert.equal(stagedEntries.includes("previous-notify.json"), false);
  const stagedText = (
    await Promise.all(
      stagedEntries.map(async (entry) => {
        const path = join(stage.root, entry);
        return (await stat(path)).isFile() ? readFile(path, "utf8") : "";
      }),
    )
  ).join("\n");
  assert.doesNotMatch(stagedText, new RegExp(sentinel, "u"));
  assert.deepEqual(stage.previousNotify, ["/usr/bin/printf", sentinel]);
});

test("upgrade is idempotent and preserves an edited public config.json", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const customConfig = `${JSON.stringify(
    {
      bark: {
        endpoint: "https://example.invalid/push",
        icon: "https://example.invalid/icon.png",
        group: "My Codex",
        sound: "birdsong",
        requestTimeoutMilliseconds: 12_000,
      },
      userExtension: true,
    },
    null,
    2,
  )}\n`;
  await writeFile(context.paths.runtimeConfig, customConfig);
  await chmod(context.paths.runtimeConfig, 0o644);

  await installFixture(context);
  assert.equal(
    await readFile(context.paths.runtimeConfig, "utf8"),
    customConfig,
  );
  assert.equal(fileMode(await stat(context.paths.runtimeConfig)), 0o600);
  const hooks = JSON.parse(await readFile(context.paths.hooksJson, "utf8"));
  assert.equal(hooks.hooks.PermissionRequest.length, 1);
  const manifest = await readManifest(context.paths);
  assert.equal(Object.hasOwn(manifest.files, context.paths.runtimeConfig), false);
});

test("reinstall keeps an existing device key even when --key-file is supplied", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const originalKey = await readFile(context.paths.key, "utf8");
  const replacementKeyFile = join(context.root, "replacement-key");
  await writeFile(replacementKeyFile, "replacementDeviceKey98765\n", {
    mode: 0o600,
  });

  await installFixture(context, ["--key-file", replacementKeyFile]);
  assert.equal(await readFile(context.paths.key, "utf8"), originalKey);
});

test("dry-run performs zero writes and does not require a key", async (t) => {
  const context = await fixture(t);
  const legacySnapshot = join(
    context.paths.installRoot,
    "..",
    "codex-bark.rollback-Dry123",
  );
  await mkdir(legacySnapshot, { recursive: true });
  const before = await readdir(context.codexHome, { recursive: true });
  const result = await install({
    argv: ["--dry-run"],
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
  assert.equal(result.outcome, "dry-run");
  assert.deepEqual(
    await readdir(context.codexHome, { recursive: true }),
    before,
  );
  assert.equal(await pathExists(legacySnapshot), true);
});

test("real install removes a strictly matched legacy rollback snapshot", async (t) => {
  const context = await fixture(t);
  const legacySnapshot = join(
    context.paths.installRoot,
    "..",
    "codex-bark.rollback-Old123",
  );
  await mkdir(legacySnapshot, { recursive: true });
  await writeFile(join(legacySnapshot, "bark-device-key"), "LEGACY_KEY");
  await installFixture(context);
  assert.equal(await pathExists(legacySnapshot), false);
});

test("install and ordinary uninstall reject legacy cleanup through an ancestor symlink", async (t) => {
  const context = await fixture(t);
  const externalNotifications = join(
    context.root,
    "external-notifications",
  );
  const legacySnapshot = join(
    externalNotifications,
    "codex-bark.rollback-Ab12Cd",
  );
  const sentinel = join(legacySnapshot, "must-survive");
  await mkdir(legacySnapshot, { recursive: true });
  await writeFile(sentinel, "safe");
  await symlink(
    externalNotifications,
    join(context.codexHome, "notifications"),
  );

  await assert.rejects(
    install({
      argv: ["--key-file", join(context.root, "missing-key-file")],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    /canonical private path is unexpected/u,
  );
  assert.equal(await readFile(sentinel, "utf8"), "safe");

  await assert.rejects(
    uninstall({
      argv: [],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    /canonical private path is unexpected/u,
  );
  assert.equal(await readFile(sentinel, "utf8"), "safe");
});

test("TOML merge preserves a leading BOM and rejects conflicting top-level features forms", async (t) => {
  assert.throws(
    () => enableHooksFeature("features.hooks = false\n"),
    /unsafe to edit/u,
  );
  assert.throws(
    () => enableHooksFeature("features = { hooks = false }\n"),
    /unsafe to edit/u,
  );

  const original = '\uFEFFmodel = "with-bom"\n';
  const context = await fixture(t, { config: original });
  await installFixture(context);
  const installed = await readFile(context.paths.configToml, "utf8");
  assert.equal(installed[0], "\uFEFF");
  assert.equal(installed.indexOf("\uFEFF", 1), -1);
  await uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME });
  assert.equal(await readFile(context.paths.configToml, "utf8"), original);
});

test("uninstall removes only managed config and keeps later unrelated user additions", async (t) => {
  const context = await fixture(t, {
    config: 'model = "before"\n\n[features]\nother = true\n',
    hooks: '{"hooks":{}}\n',
  });
  await installFixture(context);

  const configWithUserChange = (
    await readFile(context.paths.configToml, "utf8")
  ).replace("other = true", "other = true\nadded_after_install = true");
  await writeFile(context.paths.configToml, configWithUserChange);
  const hooksWithUserChange = JSON.parse(
    await readFile(context.paths.hooksJson, "utf8"),
  );
  hooksWithUserChange.hooks.AfterInstall = [
    { hooks: [{ type: "command", command: "/bin/true" }] },
  ];
  await writeFile(
    context.paths.hooksJson,
    `${JSON.stringify(hooksWithUserChange, null, 2)}\n`,
  );

  await uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME });
  const restoredConfig = await readFile(context.paths.configToml, "utf8");
  assert.doesNotMatch(restoredConfig, /^notify\s*=/mu);
  assert.doesNotMatch(restoredConfig, /^hooks\s*=/mu);
  assert.match(restoredConfig, /model = "before"/u);
  assert.match(restoredConfig, /added_after_install = true/u);
  const restoredHooks = JSON.parse(
    await readFile(context.paths.hooksJson, "utf8"),
  );
  assert.equal(restoredHooks.hooks.PermissionRequest, undefined);
  assert.equal(restoredHooks.hooks.AfterInstall.length, 1);
});

test("related config conflicts are rejected without removing runtime files", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const conflictingConfig = (
    await readFile(context.paths.configToml, "utf8")
  ).replace(/^notify\s*=.*$/mu, 'notify = ["/bin/false"]');
  await writeFile(context.paths.configToml, conflictingConfig);

  await assert.rejects(
    uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME }),
    /managed notify setting changed/u,
  );
  assert.equal(await readFile(context.paths.configToml, "utf8"), conflictingConfig);
  assert.equal(await pathExists(context.paths.entry), true);
  assert.equal((await readManifest(context.paths)).status, "installed");
});

test("purge deletes fixed private data when configuration cannot be safely restored", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const conflictingConfig = (
    await readFile(context.paths.configToml, "utf8")
  ).replace(/^notify\s*=.*$/mu, 'notify = ["/bin/false"]');
  await writeFile(context.paths.configToml, conflictingConfig);

  const result = await uninstall({
    argv: ["--purge"],
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
  assert.equal(result.outcome, "purged-without-config-restore");
  assert.equal(result.configRestored, false);
  assert.equal(await readFile(context.paths.configToml, "utf8"), conflictingConfig);
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(await pathExists(context.paths.backupRoot), false);
});

test("purge deletes fixed private data when installed.json is invalid", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const installedConfig = await readFile(context.paths.configToml, "utf8");
  await writeFile(context.paths.manifest, "{invalid json");

  const result = await uninstall({
    argv: ["--purge"],
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
  assert.equal(result.outcome, "purged-without-config-restore");
  assert.equal(result.configRestored, false);
  assert.equal(await readFile(context.paths.configToml, "utf8"), installedConfig);
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(await pathExists(context.paths.backupRoot), false);
});

test("purge does not downgrade installed.json I/O failures into invalid-manifest cleanup", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  await chmod(context.paths.manifest, 0o000);

  await assert.rejects(
    uninstall({
      argv: ["--purge"],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    (error) => error?.code === "EACCES",
  );
  assert.equal(await pathExists(context.paths.installRoot), true);
  assert.equal(await pathExists(context.paths.backupRoot), true);
});

test("install and uninstall failures roll back the operation-start state", async (t) => {
  const fresh = await fixture(t);
  const failManifestWrite = async (path, content, mode) => {
    await atomicWrite(path, content, mode);
    if (path === fresh.paths.manifest) {
      throw new Error("injected install failure");
    }
  };
  await assert.rejects(
    install({
      argv: ["--key-file", fresh.keyFile],
      paths: fresh.paths,
      runtime: TEST_RUNTIME,
      operations: { atomicWrite: failManifestWrite },
    }),
    /injected install failure/u,
  );
  assert.equal(await pathExists(fresh.paths.installRoot), false);
  assert.equal(await pathExists(fresh.paths.configToml), false);
  assert.equal(await pathExists(fresh.paths.hooksJson), false);
  assert.equal(
    (await readdir(join(fresh.paths.installRoot, ".."))).some((entry) =>
      entry.startsWith("codex-bark.rollback-"),
    ),
    false,
  );

  const installed = await fixture(t, {
    config: 'model = "before"\n',
    hooks: '{"hooks":{"Stop":[]}}\n',
  });
  await installFixture(installed);
  const configAtUninstallStart = (
    await readFile(installed.paths.configToml, "utf8")
  ).replace('model = "before"', 'model = "changed later"');
  await writeFile(installed.paths.configToml, configAtUninstallStart);
  const hooksAtUninstallStart = await readFile(
    installed.paths.hooksJson,
    "utf8",
  );
  const manifestAtUninstallStart = await readFile(
    installed.paths.manifest,
    "utf8",
  );
  const keyAtUninstallStart = await readFile(installed.paths.key, "utf8");
  await mkdir(installed.paths.jobs, { recursive: true });
  await mkdir(installed.paths.state, { recursive: true });
  await writeFile(
    join(installed.paths.jobs, "pending-private-job"),
    "PRIVATE_JOB_AT_UNINSTALL_START",
  );
  await writeFile(
    join(installed.paths.state, "pending-private-state"),
    "PRIVATE_STATE_AT_UNINSTALL_START",
  );
  await writeFile(
    installed.paths.auditLog,
    "PRIVATE_AUDIT_AT_UNINSTALL_START",
  );
  const failUninstallManifest = async (path, content, mode) => {
    await atomicWrite(path, content, mode);
    if (path === installed.paths.manifest) {
      throw new Error("injected uninstall failure");
    }
  };
  await assert.rejects(
    uninstall({
      argv: [],
      paths: installed.paths,
      runtime: TEST_RUNTIME,
      operations: { atomicWrite: failUninstallManifest },
    }),
    /injected uninstall failure/u,
  );
  assert.equal(
    await readFile(installed.paths.configToml, "utf8"),
    configAtUninstallStart,
  );
  assert.equal(
    await readFile(installed.paths.hooksJson, "utf8"),
    hooksAtUninstallStart,
  );
  assert.equal(
    await readFile(installed.paths.manifest, "utf8"),
    manifestAtUninstallStart,
  );
  assert.equal(await pathExists(installed.paths.entry), true);
  assert.equal(
    await readFile(installed.paths.key, "utf8"),
    keyAtUninstallStart,
  );
  assert.equal(
    await readFile(
      join(installed.paths.jobs, "pending-private-job"),
      "utf8",
    ),
    "PRIVATE_JOB_AT_UNINSTALL_START",
  );
  assert.equal(
    await readFile(
      join(installed.paths.state, "pending-private-state"),
      "utf8",
    ),
    "PRIVATE_STATE_AT_UNINSTALL_START",
  );
  assert.equal(
    await readFile(installed.paths.auditLog, "utf8"),
    "PRIVATE_AUDIT_AT_UNINSTALL_START",
  );
});

test("normal uninstall commits before ephemeral cleanup warnings", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  await mkdir(context.paths.jobs, { recursive: true });
  await mkdir(context.paths.state, { recursive: true });
  const result = await uninstall({
    argv: [],
    paths: context.paths,
    runtime: TEST_RUNTIME,
    operations: {
      cleanupRuntimeEphemera: async () => {
        throw new Error("injected cleanup failure");
      },
    },
  });
  assert.equal(result.outcome, "uninstalled");
  assert.match(result.cleanupWarning, /could not be fully removed/u);
  assert.equal((await readManifest(context.paths)).status, "uninstalled");
  assert.equal(await pathExists(context.paths.entry), false);
  assert.equal(await pathExists(context.paths.key), true);
  assert.equal(await pathExists(context.paths.jobs), true);
  assert.equal(await pathExists(context.paths.state), true);
});

test("purge failure after private deletion is reported as irreversible", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const legacySnapshot = join(
    context.paths.installRoot,
    "..",
    "codex-bark.rollback-Fail02",
  );
  await mkdir(legacySnapshot, { recursive: true });
  await writeFile(join(legacySnapshot, "legacy-private-data"), "PRIVATE");
  await assert.rejects(
    uninstall({
      argv: ["--purge"],
      paths: context.paths,
      runtime: TEST_RUNTIME,
      operations: {
        purgeRemove: async (path, options) => {
          if (path === context.paths.backupRoot) {
            throw new Error("injected backup purge failure");
          }
          return rm(path, options);
        },
      },
    }),
    /irreversible deletion step.*partially completed/u,
  );
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(await pathExists(context.paths.configToml), false);
  assert.equal(await pathExists(context.paths.hooksJson), false);
  assert.equal(await pathExists(context.paths.backupRoot), true);
  assert.equal(await pathExists(legacySnapshot), false);
});

test("rollback snapshots exclude keys, jobs, state, and audit data", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  await mkdir(context.paths.jobs, { recursive: true });
  await mkdir(context.paths.state, { recursive: true });
  await writeFile(
    join(context.paths.jobs, "private-job.json"),
    "JOB_SECRET_MUST_NOT_REACH_SNAPSHOT",
  );
  await writeFile(
    join(context.paths.state, "private-state"),
    "STATE_SECRET_MUST_NOT_REACH_SNAPSHOT",
  );
  await writeFile(
    context.paths.auditLog,
    "AUDIT_SECRET_MUST_NOT_REACH_SNAPSHOT",
  );

  const snapshot = await createRuntimeSnapshot(context.paths);
  const installParentEntries = await readdir(
    join(context.paths.installRoot, ".."),
  );
  assert.equal(
    installParentEntries.some((entry) =>
      entry.startsWith("codex-bark.rollback-"),
    ),
    false,
  );
  assert.deepEqual(
    snapshot.managed.map((item) => item.target),
    [
      context.paths.entry,
      context.paths.library,
      context.paths.dispatcher,
      context.paths.previousNotify,
      context.paths.manifest,
    ],
  );
  const capturedText = snapshot.managed
    .flatMap((item) => item.entries)
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.content.toString("utf8"))
    .join("\n");
  assert.doesNotMatch(
    capturedText,
    /testDeviceKey|JOB_SECRET|STATE_SECRET|AUDIT_SECRET/u,
  );

  const preservedKey = await readFile(context.paths.key, "utf8");
  await writeFile(context.paths.entry, "mutated managed runtime");
  await restoreRuntimeSnapshot(context.paths, snapshot);
  assert.notEqual(
    await readFile(context.paths.entry, "utf8"),
    "mutated managed runtime",
  );
  assert.equal(await readFile(context.paths.key, "utf8"), preservedKey);
  assert.equal(
    await readFile(join(context.paths.jobs, "private-job.json"), "utf8"),
    "JOB_SECRET_MUST_NOT_REACH_SNAPSHOT",
  );
});

test("tampered manifest cannot direct deletion outside installRoot", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const outside = join(context.root, "must-survive");
  await writeFile(outside, "safe");
  const manifest = JSON.parse(await readFile(context.paths.manifest, "utf8"));
  manifest.files[outside] = "0".repeat(64);
  await writeFile(
    context.paths.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await assert.rejects(
    uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME }),
    /unsafe managed file path/u,
  );
  assert.equal(await readFile(outside, "utf8"), "safe");
});

test("sensitive runtime symlinks are rejected fail-closed", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const realKey = join(context.root, "real-key");
  await writeFile(realKey, "differentKey12345\n");
  await rm(context.paths.key);
  await symlink(realKey, context.paths.key);

  await assert.rejects(
    install({
      argv: [],
      paths: context.paths,
      runtime: TEST_RUNTIME,
    }),
    /symbolic link/u,
  );
  await assert.rejects(
    uninstall({ argv: [], paths: context.paths, runtime: TEST_RUNTIME }),
    /symbolic link/u,
  );
  assert.equal((await lstat(context.paths.key)).isSymbolicLink(), true);

  await uninstall({
    argv: ["--purge"],
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(await readFile(realKey, "utf8"), "differentKey12345\n");
});

test("purge treats a linked manifest as untrusted without deleting its target", async (t) => {
  const context = await fixture(t);
  await installFixture(context);
  const linkedManifestTarget = join(context.root, "linked-manifest-target");
  await writeFile(linkedManifestTarget, '{"outside":"must survive"}\n');
  await rm(context.paths.manifest);
  await symlink(linkedManifestTarget, context.paths.manifest);

  const result = await uninstall({
    argv: ["--purge"],
    paths: context.paths,
    runtime: TEST_RUNTIME,
  });
  assert.equal(result.outcome, "purged-without-config-restore");
  assert.equal(result.configRestored, false);
  assert.equal(await pathExists(context.paths.installRoot), false);
  assert.equal(
    await readFile(linkedManifestTarget, "utf8"),
    '{"outside":"must survive"}\n',
  );
});

test("dispatcher exits after its timeout even when the previous notifier ignores SIGTERM", async (t) => {
  const context = await fixture(t);
  await mkdir(context.paths.installRoot, { recursive: true });
  await writeFile(
    context.paths.dispatcher,
    dispatcherSource({ timeoutMilliseconds: 300 }),
    { mode: 0o700 },
  );
  await writeFile(
    context.paths.entry,
    "#!/usr/bin/env node\nprocess.exit(0);\n",
    { mode: 0o700 },
  );
  await writeFile(
    context.paths.previousNotify,
    `${JSON.stringify([
      process.execPath,
      "-e",
      'process.on("SIGTERM",()=>{});setTimeout(()=>{},1500)',
    ])}\n`,
  );

  const started = Date.now();
  const exitCode = await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [context.paths.dispatcher, '{"type":"agent-turn-complete"}'],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", resolvePromise);
  });
  assert.equal(exitCode, 0);
  assert.ok(
    Date.now() - started < 1_000,
    "dispatcher remained blocked by the unreferenced previous notifier",
  );
});
