import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOTSTRAP = join(PROJECT_ROOT, "scripts", "install.sh");

async function temporaryBootstrapEnvironment(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-bark-bootstrap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const pathDirectory = join(root, "path");
  const applicationsRoot = join(root, "Applications");
  const home = join(root, "home");
  const log = join(root, "node-invocations.log");
  await Promise.all([
    mkdir(pathDirectory, { recursive: true }),
    mkdir(applicationsRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);

  return { root, pathDirectory, applicationsRoot, home, log };
}

async function createFakeNode(path, { label, version = "v22.0.0" }) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
{
  printf 'BEGIN:%s\\n' '${label}'
  printf 'ARGC:%s\\n' "$#"
  for argument do
    printf 'ARG:<%s>\\n' "$argument"
  done
  printf '%s\\n' 'END'
} >> "$BOOTSTRAP_TEST_LOG"
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

function runBootstrap(context, args = [], environment = {}) {
  const env = {
    ...process.env,
    PATH: context.pathDirectory,
    HOME: context.home,
    BOOTSTRAP_TEST_LOG: context.log,
    _CODEX_BARK_TEST_APPLICATIONS_ROOT: context.applicationsRoot,
    ...environment,
  };
  if (!("CODEX_BARK_NODE" in environment)) {
    delete env.CODEX_BARK_NODE;
  }
  if (!("CODEX_HOME" in environment)) {
    delete env.CODEX_HOME;
  }

  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [BOOTSTRAP, ...args], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function invocationLog(context) {
  try {
    return await readFile(context.log, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function systemNode(context, appName) {
  return join(
    context.applicationsRoot,
    `${appName}.app`,
    "Contents",
    "Resources",
    "cua_node",
    "bin",
    "node",
  );
}

function userNode(context, appName) {
  return join(
    context.home,
    "Applications",
    `${appName}.app`,
    "Contents",
    "Resources",
    "cua_node",
    "bin",
    "node",
  );
}

test("CODEX_BARK_NODE is an explicit validated override and preserves arguments", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  const override = await createFakeNode(
    join(context.root, "override node directory", "node"),
    {
      label: "override",
      version: "v24.3.0",
    },
  );
  await createFakeNode(join(context.pathDirectory, "node"), {
    label: "path",
    version: "v25.0.0",
  });
  await createFakeNode(systemNode(context, "ChatGPT"), {
    label: "system-chatgpt",
  });

  const result = await runBootstrap(
    context,
    ["--dry-run", "two words", "--key-file", "private input"],
    { CODEX_BARK_NODE: override },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(await invocationLog(context), /^BEGIN:override$/mu);
  assert.doesNotMatch(await invocationLog(context), /^BEGIN:path$/mu);
  assert.match(
    await invocationLog(context),
    /ARG:<--dry-run>\nARG:<two words>\nARG:<--key-file>\nARG:<private input>/u,
  );
  assert.match(
    await invocationLog(context),
    new RegExp(`ARG:<${join(PROJECT_ROOT, "scripts", "install.mjs")}>`, "u"),
  );
});

test("PATH node wins bundled runtimes", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  await createFakeNode(join(context.pathDirectory, "node"), {
    label: "path",
  });
  await createFakeNode(systemNode(context, "ChatGPT"), {
    label: "system-chatgpt",
    version: "v25.0.0",
  });

  const result = await runBootstrap(context, ["--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await invocationLog(context), /^BEGIN:path$/mu);
  assert.doesNotMatch(await invocationLog(context), /system-chatgpt/u);
});

test("system ChatGPT runtime wins later bundled candidates", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  await createFakeNode(systemNode(context, "ChatGPT"), {
    label: "system-chatgpt",
  });
  await createFakeNode(systemNode(context, "Codex"), {
    label: "system-codex",
  });
  await createFakeNode(userNode(context, "ChatGPT"), {
    label: "user-chatgpt",
  });

  const result = await runBootstrap(context, ["--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await invocationLog(context), /^BEGIN:system-chatgpt$/mu);
});

test("old automatic candidates are skipped in documented bundle order", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  await createFakeNode(join(context.pathDirectory, "node"), {
    label: "old-path",
    version: "v20.19.0",
  });
  await createFakeNode(systemNode(context, "ChatGPT"), {
    label: "old-system-chatgpt",
    version: "v21.9.0",
  });
  await createFakeNode(systemNode(context, "Codex"), {
    label: "system-codex",
    version: "v22.0.0",
  });
  await createFakeNode(userNode(context, "ChatGPT"), {
    label: "user-chatgpt",
    version: "v25.0.0",
  });

  const result = await runBootstrap(context, ["--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await invocationLog(context), /^BEGIN:system-codex$/mu);
  assert.doesNotMatch(await invocationLog(context), /^BEGIN:user-chatgpt$/mu);
});

test("user ChatGPT runtime wins the user-level Codex fallback", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  await createFakeNode(userNode(context, "ChatGPT"), {
    label: "user-chatgpt",
  });
  await createFakeNode(userNode(context, "Codex"), {
    label: "user-codex",
  });

  const result = await runBootstrap(context, ["--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await invocationLog(context), /^BEGIN:user-chatgpt$/mu);
  assert.doesNotMatch(await invocationLog(context), /^BEGIN:user-codex$/mu);
});

test("an old explicit override fails instead of silently falling back", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  const override = await createFakeNode(join(context.root, "old-override"), {
    label: "old-override",
    version: "v20.0.0",
  });
  await createFakeNode(join(context.pathDirectory, "node"), {
    label: "path",
    version: "v25.0.0",
  });

  const result = await runBootstrap(context, ["--dry-run"], {
    CODEX_BARK_NODE: override,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /CODEX_BARK_NODE must be a working Node\.js 22\+/u);
  assert.equal(await invocationLog(context), "");
});

test("missing compatible runtimes fails with actionable guidance", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  const result = await runBootstrap(context, ["--dry-run"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No compatible Node\.js runtime found/u);
  assert.match(result.stderr, /set CODEX_BARK_NODE/u);
  assert.equal(await invocationLog(context), "");
});

test("--verify checks three entry points then runs the full test suite", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  await createFakeNode(join(context.pathDirectory, "node"), {
    label: "verify",
  });

  const result = await runBootstrap(context, ["--verify"]);
  assert.equal(result.code, 0, result.stderr);
  const log = await invocationLog(context);
  assert.equal((log.match(/^BEGIN:verify$/gmu) ?? []).length, 4);
  assert.match(
    log,
    new RegExp(
      `ARG:<--check>\\nARG:<${join(PROJECT_ROOT, "src", "bark-notify.mjs")}>[\\s\\S]*` +
        `ARG:<--check>\\nARG:<${join(PROJECT_ROOT, "scripts", "install.mjs")}>[\\s\\S]*` +
        `ARG:<--check>\\nARG:<${join(PROJECT_ROOT, "scripts", "uninstall.mjs")}>[\\s\\S]*` +
        "ARG:<--test>",
      "u",
    ),
  );
});

test("--send-test uses CODEX_HOME and passes only the notifier test arguments", async (t) => {
  const context = await temporaryBootstrapEnvironment(t);
  await createFakeNode(join(context.pathDirectory, "node"), {
    label: "send-test",
  });
  const codexHome = join(context.root, "custom-codex-home");
  const notifier = join(
    codexHome,
    "notifications",
    "codex-bark",
    "bark-notify.mjs",
  );
  await mkdir(dirname(notifier), { recursive: true });
  await writeFile(notifier, "// test placeholder\n");

  const result = await runBootstrap(context, ["--send-test"], {
    CODEX_HOME: codexHome,
  });
  assert.equal(result.code, 0, result.stderr);
  const log = await invocationLog(context);
  assert.match(log, /^BEGIN:send-test$/mu);
  assert.match(log, /ARGC:2/u);
  assert.match(
    log,
    new RegExp(`ARG:<${notifier}>\\nARG:<--test>`, "u"),
  );
});

test("--uninstall selects uninstall.mjs and preserves all remaining arguments", async (t) => {
  for (const forwardedArguments of [[], ["--dry-run"], ["--purge"]]) {
    await t.test(
      forwardedArguments[0] ?? "without options",
      async (subtest) => {
        const context = await temporaryBootstrapEnvironment(subtest);
        await createFakeNode(join(context.pathDirectory, "node"), {
          label: "uninstall",
        });

        const result = await runBootstrap(context, [
          "--uninstall",
          ...forwardedArguments,
        ]);
        assert.equal(result.code, 0, result.stderr);

        const log = await invocationLog(context);
        const expectedArguments = [
          join(PROJECT_ROOT, "scripts", "uninstall.mjs"),
          ...forwardedArguments,
        ];
        assert.match(log, /^BEGIN:uninstall$/mu);
        assert.match(log, new RegExp(`ARGC:${expectedArguments.length}`, "u"));
        for (const argument of expectedArguments) {
          assert.match(log, new RegExp(`ARG:<${argument}>`, "u"));
        }
        assert.doesNotMatch(log, /ARG:<--uninstall>/u);
      },
    );
  }
});
