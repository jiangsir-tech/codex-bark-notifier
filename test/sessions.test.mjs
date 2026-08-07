import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildPermissionNotification } from "../src/bark-notify.mjs";
import {
  assistantSummaryFromTranscript,
  classifySessionMetaPayload,
  conversationNameFromTranscript,
  notificationContext,
  resolvedThreadKind,
  sessionMetaFromTranscript,
  sessionPathForThreadId,
  taskNameFromIndex,
  THREAD_KIND_RETRY_DELAYS,
  threadKind,
} from "../src/lib/sessions.mjs";
import {
  jsonl,
  removeTemporaryPaths,
  temporaryPaths,
} from "./helpers.mjs";

test("session metadata distinguishes main, subagent, and unknown", () => {
  assert.equal(classifySessionMetaPayload({ id: "main" }, "main"), "main");
  assert.equal(
    classifySessionMetaPayload(
      { id: "child", parent_thread_id: "main" },
      "child",
    ),
    "subagent",
  );
  assert.equal(
    classifySessionMetaPayload(
      {
        id: "child",
        source: { subagent: { thread_spawn: { parent_thread_id: "main" } } },
      },
      "child",
    ),
    "subagent",
  );
  assert.equal(classifySessionMetaPayload(null, "missing"), "unknown");
  assert.equal(classifySessionMetaPayload({ id: "other" }, "missing"), "unknown");
});

test("thread lookup resolves real main/subagent files and unknown safely", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const day = join(paths.sessionRoot, "2026", "07", "30");
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, "rollout-main.jsonl-main.jsonl"),
    jsonl({ type: "session_meta", payload: { id: "main" } }),
  );
  await writeFile(
    join(day, "rollout-child.jsonl-child.jsonl"),
    jsonl({
      type: "session_meta",
      payload: { id: "child", parent_thread_id: "main" },
    }),
  );

  assert.equal(await threadKind({ "thread-id": "main" }, paths), "main");
  assert.equal(await threadKind({ "thread-id": "child" }, paths), "subagent");
  assert.equal(await threadKind({ "thread-id": "missing" }, paths), "unknown");
  assert.equal(
    await resolvedThreadKind({ "thread-id": "missing" }, paths, {
      retryDelays: [0, 0, 0],
      sleep: async () => {},
    }),
    "unknown",
  );
});

test("thread lookup falls back to archived sessions", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const archivedRoot = join(dirname(paths.sessionRoot), "archived_sessions");
  await mkdir(archivedRoot, { recursive: true });
  const archivedTranscript = join(
    archivedRoot,
    "rollout-archived-thread.jsonl",
  );
  await writeFile(
    archivedTranscript,
    jsonl({ type: "session_meta", payload: { id: "archived-thread" } }),
  );

  assert.equal(
    await sessionPathForThreadId("archived-thread", paths.sessionRoot),
    archivedTranscript,
  );
  assert.equal(
    await threadKind({ "thread-id": "archived-thread" }, paths),
    "main",
  );
});

test("thread lookup prefers a supplied transcript and recovers from a stale path", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const threadId = "preferred-thread";
  const discoveredTranscript = join(
    paths.sessionRoot,
    `rollout-discovered-${threadId}.jsonl`,
  );
  const preferredTranscript = join(
    paths.root,
    `rollout-preferred-${threadId}.jsonl`,
  );
  await writeFile(
    discoveredTranscript,
    jsonl({
      type: "session_meta",
      payload: { id: threadId, parent_thread_id: "parent-thread" },
    }),
  );
  await writeFile(
    preferredTranscript,
    jsonl({ type: "session_meta", payload: { id: threadId } }),
  );

  assert.equal(
    await threadKind(
      { "thread-id": threadId, transcript_path: preferredTranscript },
      paths,
    ),
    "main",
  );
  assert.equal(
    await threadKind(
      {
        "thread-id": threadId,
        transcript_path: join(paths.root, "moved-away.jsonl"),
      },
      paths,
    ),
    "subagent",
  );
});

test("resolvedThreadKind retries until session metadata appears", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  let sleeps = 0;
  const payload = { "thread-id": "late" };

  const kind = await resolvedThreadKind(payload, paths, {
    retryDelays: [1, 1, 1],
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await writeFile(
          join(paths.sessionRoot, "rollout-late.jsonl-late.jsonl"),
          jsonl({ type: "session_meta", payload: { id: "late" } }),
        );
      }
    },
  });

  assert.equal(kind, "main");
  assert.equal(sleeps, 1);
});

test("default thread-kind retry window is long enough for late transcripts", () => {
  assert.deepEqual(THREAD_KIND_RETRY_DELAYS, [500, 1_000, 2_000, 4_000]);
  assert.equal(
    THREAD_KIND_RETRY_DELAYS.reduce((total, delay) => total + delay, 0),
    7_500,
  );
});

test("PermissionRequest from a subagent maps to parent task and conversation", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const childId = "child-thread";
  const parentId = "parent-thread";
  const childTranscript = join(
    paths.sessionRoot,
    `rollout-child-${childId}.jsonl`,
  );
  const parentTranscript = join(
    paths.sessionRoot,
    `rollout-parent-${parentId}.jsonl`,
  );

  await writeFile(
    childTranscript,
    jsonl({
      type: "session_meta",
      payload: {
        id: childId,
        source: {
          subagent: { thread_spawn: { parent_thread_id: parentId } },
        },
      },
    }),
  );
  await writeFile(
    parentTranscript,
    jsonl(
      { type: "session_meta", payload: { id: parentId } },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "请发布可靠的通知工具。" },
      },
    ),
  );
  await writeFile(
    paths.sessionIndex,
    jsonl({
      id: parentId,
      thread_name: "[Codex Bark 公开项目]",
    }),
  );

  const payload = {
    session_id: childId,
    transcript_path: childTranscript,
    cwd: "/tmp/fallback",
  };
  assert.deepEqual(await notificationContext(payload, paths), {
    threadId: childId,
    parentThreadId: parentId,
    notificationThreadId: parentId,
    currentTranscript: childTranscript,
    notificationTranscript: parentTranscript,
  });
  assert.deepEqual(await buildPermissionNotification(payload, paths), {
    title: "🔐 [Codex Bark 公开项目]需要你批准",
    body: "💬发布可靠的通知工具",
    url: "https://chatgpt.com/codex/tasks/parent-thread",
  });
});

test("PermissionRequest keeps absolute paths and bidi controls out of the final notification", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const threadId = "private-path-thread";
  const transcript = join(
    paths.sessionRoot,
    `rollout-main-${threadId}.jsonl`,
  );

  await writeFile(
    transcript,
    jsonl(
      { type: "session_meta", payload: { id: threadId } },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "请检查 /Users/example/My Private Repo/secrets.txt\u202e，然后继续",
        },
      },
    ),
  );
  await writeFile(
    paths.sessionIndex,
    jsonl({
      id: threadId,
      thread_name: "/Users/example/PrivateRepo/project\u202eABC",
    }),
  );

  const notification = await buildPermissionNotification(
    {
      session_id: threadId,
      transcript_path: transcript,
      cwd: "/tmp/fallback",
    },
    paths,
  );

  assert.deepEqual(notification, {
    title: "🔐 [fallback]需要你批准",
    body: "💬fallback",
    url: "https://chatgpt.com/codex/tasks/private-path-thread",
  });
  assert.equal(notification.title.includes("/Users"), false);
  assert.equal(notification.body.includes("/Users"), false);
  assert.equal(/\p{Bidi_Control}/u.test(JSON.stringify(notification)), false);
});

test("PermissionRequest redacts Bark keys and uses a safe credential-only fallback", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const threadId = "credential-thread";
  const transcript = join(
    paths.sessionRoot,
    `rollout-main-${threadId}.jsonl`,
  );
  await writeFile(
    transcript,
    jsonl(
      { type: "session_meta", payload: { id: threadId } },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "我的 Bark Device Key 是 testKey123456",
        },
      },
    ),
  );

  const notification = await buildPermissionNotification(
    {
      session_id: threadId,
      transcript_path: transcript,
      cwd: "/tmp/配置通知",
    },
    paths,
  );

  assert.deepEqual(notification, {
    title: "🔐 [配置通知]需要你批准",
    body: "💬配置通知",
    url: "https://chatgpt.com/codex/tasks/credential-thread",
  });
  assert.doesNotMatch(JSON.stringify(notification), /testKey/u);
});

test("task index uses latest matching name and strips brackets", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await writeFile(
    paths.sessionIndex,
    jsonl(
      { id: "thread", thread_name: "旧名称" },
      { id: "other", thread_name: "无关名称" },
      { id: "thread", thread_name: "[最新名称]" },
    ),
  );
  assert.equal(
    await taskNameFromIndex("thread", paths.sessionIndex, "/tmp/fallback"),
    "最新名称",
  );
});

test("assistant summary selects the exact completed turn instead of the newest reply", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const transcript = join(paths.sessionRoot, "rollout-summary-thread.jsonl");
  await writeFile(
    transcript,
    jsonl(
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "older-turn",
          last_agent_message:
            "已完成。\n\n旧轮已经修复重复推送并通过测试。",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "newer-turn",
          last_agent_message: "新一轮已经修改其他配置。",
        },
      },
    ),
  );

  assert.equal(
    await assistantSummaryFromTranscript(
      transcript,
      "older-turn",
      "旧轮用户要求",
      { retryDelays: [] },
    ),
    "旧轮已经修复重复推送并通过测试。",
  );
});

test("assistant summary falls back when the completed turn is absent or has no final reply", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const transcript = join(paths.sessionRoot, "rollout-fallback-thread.jsonl");
  await writeFile(
    transcript,
    jsonl(
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "commentary",
          message: "仍在执行中的中间进度",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "error-turn",
          error: { message: "internal error" },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "other-turn",
          last_agent_message: "另一轮的最终回复",
        },
      },
    ),
  );

  for (const turnId of ["missing-turn", "error-turn"]) {
    assert.equal(
      await assistantSummaryFromTranscript(
        transcript,
        turnId,
        "核对通知状态",
        { retryDelays: [] },
      ),
      "核对通知状态",
    );
  }
});

test("large transcripts stay readable across reverse chunk boundaries", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const threadId = "large-thread";
  const transcript = join(
    paths.sessionRoot,
    `rollout-large-${threadId}.jsonl`,
  );
  const filler = "边界填充".repeat(24 * 1024);
  const records = [
    { type: "session_meta", payload: { id: threadId } },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "旧的对话问题" },
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "event_msg",
      payload: { type: "token_count", index, filler },
    })),
    {
      type: "event_msg",
      payload: { type: "user_message", message: "核验超长会话通知" },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "target-turn",
        last_agent_message: "超长会话现在可以正确发送通知。",
      },
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "event_msg",
      payload: { type: "token_count", index: index + 12, filler },
    })),
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "newer-turn",
        last_agent_message: "另一轮的结果不能覆盖目标轮。",
      },
    },
  ];
  await writeFile(transcript, jsonl(...records));

  assert.deepEqual(
    await sessionMetaFromTranscript(transcript, threadId),
    { id: threadId },
  );
  assert.equal(
    await conversationNameFromTranscript(transcript),
    "核验超长会话通知",
  );
  assert.equal(
    await assistantSummaryFromTranscript(
      transcript,
      "target-turn",
      "摘要回退",
      { retryDelays: [] },
    ),
    "超长会话现在可以正确发送通知。",
  );
});
