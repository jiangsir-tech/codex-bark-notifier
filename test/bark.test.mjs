import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  buildBarkRequestPayload,
  codexRemoteUrl,
  loadRuntimeConfig,
  pushBark,
} from "../src/lib/bark.mjs";
import {
  removeTemporaryPaths,
  temporaryPaths,
} from "./helpers.mjs";

test("Bark POST payload includes only expected delivery fields", () => {
  assert.deepEqual(
    buildBarkRequestPayload(
      "private-device-key",
      {
        title: "✅ [任务]本轮结束",
        body: "💬对话简称",
        url: "https://chatgpt.com/codex/tasks/main-thread",
      },
      {
        group: "Codex",
        sound: "minuet",
        barkIconUrl: "https://example.test/codex.png",
      },
    ),
    {
      device_key: "private-device-key",
      title: "✅ [任务]本轮结束",
      body: "💬对话简称",
      group: "Codex",
      sound: "minuet",
      icon: "https://example.test/codex.png",
      url: "https://chatgpt.com/codex/tasks/main-thread",
    },
  );
});

test("Codex Remote links encode task ids and reject other destinations", () => {
  assert.equal(
    codexRemoteUrl("main thread/一"),
    "https://chatgpt.com/codex/tasks/main%20thread%2F%E4%B8%80",
  );
  assert.equal(codexRemoteUrl("  "), "");
  assert.equal(codexRemoteUrl("x".repeat(201)), "");
  assert.equal(codexRemoteUrl("\uD800"), "");

  for (const url of [
    "https://example.test/codex/tasks/main-thread",
    "http://chatgpt.com/codex/tasks/main-thread",
    "https://chatgpt.com/codex/tasks/",
    "https://chatgpt.com/codex/tasks/main-thread/extra",
    "https://chatgpt.com/codex/tasks/main-thread?next=https://example.test",
  ]) {
    const payload = buildBarkRequestPayload(
      "private-device-key",
      { title: "x", body: "y", url },
      { group: "Codex", sound: "minuet", barkIconUrl: "" },
    );
    assert.equal("url" in payload, false);
  }
});

test("Bark payload applies a final path and bidi safety boundary", () => {
  const payload = buildBarkRequestPayload(
    "private-device-key",
    {
      title: "✅ [/Users/example/PrivateRepo\u202e]本轮结束",
      body: "💬检查 C:\\Users\\example\\secret.txt\u2066",
    },
    {
      group: "Codex",
      sound: "minuet",
      barkIconUrl: "",
    },
  );

  assert.equal(payload.title, "通知内容已隐藏");
  assert.equal(payload.body, "💬内容含本机路径");
  assert.equal(payload.title.includes("/Users"), false);
  assert.equal(payload.body.includes("\\Users"), false);
  assert.equal(/\p{Bidi_Control}/u.test(JSON.stringify(payload)), false);
});

test("runtime config accepts nested public schema and bounds timeout", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await writeFile(
    paths.configFile,
    JSON.stringify({
      bark: {
        endpoint: "https://bark.example.test/push",
        icon: "https://example.test/icon.png",
        group: "Testing",
        sound: "bell",
        requestTimeoutMilliseconds: 999,
      },
    }),
  );
  const config = await loadRuntimeConfig(paths);
  assert.equal(config.barkEndpoint, "https://bark.example.test/push");
  assert.equal(config.barkIconUrl, "https://example.test/icon.png");
  assert.equal(config.group, "Testing");
  assert.equal(config.sound, "bell");
  assert.equal(config.requestTimeoutMilliseconds, 8_000);
});

test("pushBark sends an offline JSON POST through injected fetch", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await writeFile(paths.keyFile, "private-device-key\n");
  let request = null;
  await pushBark(
    {
      title: "🔁 [任务]需要你回复",
      body: "💬请选择下一步",
      url: "https://chatgpt.com/codex/tasks/main-thread",
    },
    paths,
    {
      runtimeConfig: {
        barkEndpoint: "https://bark.invalid/push",
        barkIconUrl: "https://assets.invalid/icon.png",
        group: "Codex",
        sound: "minuet",
        requestTimeoutMilliseconds: 1_000,
      },
      fetch: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 200 }),
        };
      },
    },
  );

  assert.equal(request.url, "https://bark.invalid/push");
  assert.equal(request.options.method, "POST");
  assert.equal(
    request.options.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assert.deepEqual(JSON.parse(request.options.body), {
    device_key: "private-device-key",
    title: "🔁 [任务]需要你回复",
    body: "💬请选择下一步",
    group: "Codex",
    sound: "minuet",
    icon: "https://assets.invalid/icon.png",
    url: "https://chatgpt.com/codex/tasks/main-thread",
  });
});

test("pushBark rejects missing keys and Bark errors without real network", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await writeFile(paths.keyFile, "\n");
  await assert.rejects(
    pushBark({ title: "x", body: "y" }, paths, {
      runtimeConfig: {
        barkEndpoint: "https://bark.invalid/push",
        barkIconUrl: "",
        group: "Codex",
        sound: "minuet",
        requestTimeoutMilliseconds: 1_000,
      },
      fetch: async () => {
        throw new Error("must not be called");
      },
    }),
    { code: "KEY_MISSING" },
  );

  await writeFile(paths.keyFile, "private-device-key");
  await assert.rejects(
    pushBark({ title: "x", body: "y" }, paths, {
      runtimeConfig: {
        barkEndpoint: "https://bark.invalid/push",
        barkIconUrl: "",
        group: "Codex",
        sound: "minuet",
        requestTimeoutMilliseconds: 1_000,
      },
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ code: 500 }),
      }),
    }),
    /Bark rejected the push \(503\)/u,
  );
});
