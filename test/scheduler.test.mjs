import assert from "node:assert/strict";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  deliverPermissionJob,
  deliverTurnJob,
  schedulePermissionNotification,
  scheduleTurnNotification,
} from "../src/bark-notify.mjs";
import {
  jsonl,
  removeTemporaryPaths,
  temporaryPaths,
} from "./helpers.mjs";

const turnPayload = {
  type: "agent-turn-complete",
  "thread-id": "main-thread",
  "turn-id": "turn-1",
  cwd: "/tmp/example",
  "input-messages": ["整理通知程序测试"],
  "last-assistant-message": "已完成。",
};

async function auditEvents(paths) {
  try {
    return (await readFile(paths.auditLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row));
  } catch {
    return [];
  }
}

test("main turn schedules one detached private job", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  let spawnCall = null;
  const result = await scheduleTurnNotification({
    ...turnPayload,
    tool_input: { cmd: "TURN_TOOL_SECRET_MUST_NOT_REACH_JOB" },
    arbitrary_secret: "TURN_EXTRA_SECRET_MUST_NOT_REACH_JOB",
    "last-assistant-message":
      "已完成。 TURN_ASSISTANT_SECRET_MUST_NOT_REACH_JOB",
  }, paths, {
    resolvedThreadKind: async () => "main",
    spawn: (...arguments_) => {
      spawnCall = arguments_;
      return {};
    },
  });

  assert.deepEqual(result, { outcome: "scheduled", delayMilliseconds: 5_000 });
  assert.equal(spawnCall[0], process.execPath);
  assert.equal(spawnCall[1][0], paths.entryPath);
  assert.equal(spawnCall[1][1], "--deliver-job");
  assert.deepEqual(spawnCall[2], { detached: true, stdio: "ignore" });
  const [jobName] = await readdir(paths.jobsDirectory);
  const rawJob = await readFile(`${paths.jobsDirectory}/${jobName}`, "utf8");
  assert.doesNotMatch(
    rawJob,
    /整理通知程序测试|TURN_TOOL_SECRET|TURN_EXTRA_SECRET|TURN_ASSISTANT_SECRET/u,
  );
  assert.deepEqual(JSON.parse(rawJob), {
    schema_version: 1,
    kind: "turn",
    thread_id: "main-thread",
    turn_id: "turn-1",
    notification_thread_id: "main-thread",
    cwd_name: "example",
    status: "complete",
    delay_ms: 5_000,
  });
  const [audit] = await auditEvents(paths);
  assert.equal(audit.event, "scheduled");
  assert.equal(audit.thread_kind, "main");
  assert.equal(audit.delay_ms, 5_000);
});

test("subagent and unknown turns are suppressed without jobs", async (t) => {
  for (const [kind, expected] of [
    ["subagent", "suppressed_subagent"],
    ["unknown", "suppressed_unknown"],
  ]) {
    const paths = await temporaryPaths();
    t.after(() => removeTemporaryPaths(paths));
    let spawned = false;
    const result = await scheduleTurnNotification(turnPayload, paths, {
      resolvedThreadKind: async () => kind,
      spawn: () => {
        spawned = true;
        return {};
      },
    });
    assert.equal(result.outcome, expected);
    assert.equal(spawned, false);
    await assert.rejects(readdir(paths.jobsDirectory), { code: "ENOENT" });
    assert.equal((await auditEvents(paths))[0].event, expected);
  }
});

test("duplicate main event does not spawn a second job", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  let spawnCount = 0;
  const dependencies = {
    resolvedThreadKind: async () => "main",
    spawn: () => {
      spawnCount += 1;
      return {};
    },
  };
  assert.equal(
    (await scheduleTurnNotification(turnPayload, paths, dependencies)).outcome,
    "scheduled",
  );
  assert.equal(
    (await scheduleTurnNotification(turnPayload, paths, dependencies)).outcome,
    "suppressed_duplicate",
  );
  assert.equal(spawnCount, 1);
  assert.deepEqual(
    (await auditEvents(paths)).map((record) => record.event),
    ["scheduled", "suppressed_duplicate"],
  );
});

test("completion background delivery waits, pushes once, marks sent, and removes job", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await writeFile(
    join(paths.sessionRoot, "rollout-main-thread.jsonl"),
    jsonl(
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "整理通知程序测试",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message:
            "已完成。\n\n通知程序已经升级，并通过全部测试。",
        },
      },
    ),
  );
  let jobPath = "";
  await scheduleTurnNotification(turnPayload, paths, {
    resolvedThreadKind: async () => "main",
    spawn: (_node, arguments_) => {
      jobPath = arguments_[2];
      return {};
    },
  });

  let waited = null;
  let pushed = null;
  await deliverTurnJob(jobPath, paths, {
    sleep: async (milliseconds) => {
      await assert.rejects(lstat(jobPath), { code: "ENOENT" });
      waited = milliseconds;
    },
    pushBark: async (notification) => {
      pushed = notification;
    },
  });

  assert.equal(waited, 5_000);
  assert.deepEqual(pushed, {
    title: "✅ [example]本轮结束",
    body: "💬通知程序已经升级，并通过全部测试。",
    url: "https://chatgpt.com/codex/tasks/main-thread",
  });
  await assert.rejects(lstat(jobPath), { code: "ENOENT" });
  assert.equal(
    (await readdir(paths.stateDirectory)).some((name) => name.endsWith(".sent")),
    true,
  );
  assert.deepEqual(
    (await auditEvents(paths)).map((record) => record.event),
    ["scheduled", "sent"],
  );
});

test("reference-only jobs preserve reply and error notification states", async (t) => {
  for (const [turnId, lastReply, expectedTitle, expectedBody = lastReply] of [
    ["reply-turn", "请回复我？", "🔁 [example]需要你回复"],
    [
      "direct-feedback-turn",
      "三版提示音已生成。\n你听完告诉我选 A、B 还是 C。",
      "🔁 [example]需要你回复",
      "三版提示音已生成。",
    ],
    ["error-turn", "系统错误，任务中断。", "⛔ [example]受阻或出错"],
  ]) {
    const paths = await temporaryPaths();
    t.after(() => removeTemporaryPaths(paths));
    await writeFile(
      join(paths.sessionRoot, "rollout-main-thread.jsonl"),
      jsonl(
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "核对后台通知状态",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: turnId,
            last_agent_message: lastReply,
          },
        },
      ),
    );
    let jobPath = "";
    await scheduleTurnNotification(
      {
        ...turnPayload,
        "turn-id": turnId,
        "last-assistant-message": lastReply,
      },
      paths,
      {
        resolvedThreadKind: async () => "main",
        spawn: (_node, arguments_) => {
          jobPath = arguments_[2];
          return {};
        },
      },
    );
    let pushed = null;
    await deliverTurnJob(jobPath, paths, {
      sleep: async () => {},
      pushBark: async (notification) => {
        pushed = notification;
      },
    });
    assert.deepEqual(pushed, {
      title: expectedTitle,
      body: `💬${expectedBody}`,
      url: "https://chatgpt.com/codex/tasks/main-thread",
    });
  }
});

test("spawn failure removes the job, releases lock, and allows retry", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const failed = await scheduleTurnNotification(turnPayload, paths, {
    resolvedThreadKind: async () => "main",
    spawn: () => {
      throw new Error("spawn failed");
    },
  });
  assert.equal(failed.outcome, "failed_to_schedule");
  assert.deepEqual(await readdir(paths.jobsDirectory), []);
  assert.deepEqual(await readdir(paths.stateDirectory), []);
  assert.deepEqual(
    (await auditEvents(paths)).map((record) => record.event),
    ["scheduled", "failed_to_schedule"],
  );

  const retry = await scheduleTurnNotification(turnPayload, paths, {
    resolvedThreadKind: async () => "main",
    spawn: () => ({}),
  });
  assert.equal(retry.outcome, "scheduled");
});

test("permission hook schedules an immediate background job offline", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const hookInput = {
    session_id: "main-thread",
    transcript_path: "",
    cwd: "/tmp/example",
    tool_name: "exec_command",
    tool_input: { cmd: "sensitive command" },
  };
  let spawnCall = null;
  const result = await schedulePermissionNotification(hookInput, paths, {
    spawn: (...arguments_) => {
      spawnCall = arguments_;
      return {};
    },
  });
  assert.deepEqual(result, { outcome: "scheduled" });
  assert.equal(spawnCall[0], process.execPath);
  assert.deepEqual(spawnCall[1].slice(0, 2), [
    paths.entryPath,
    "--deliver-permission-job",
  ]);
  assert.deepEqual(spawnCall[2], { detached: true, stdio: "ignore" });
  const jobs = await readdir(paths.jobsDirectory);
  assert.equal(jobs.length, 1);
  assert.equal((await lstat(`${paths.jobsDirectory}/${jobs[0]}`)).mode & 0o777, 0o600);
  const rawJob = await readFile(
    `${paths.jobsDirectory}/${jobs[0]}`,
    "utf8",
  );
  assert.doesNotMatch(rawJob, /sensitive command|tool_input|tool_name/u);
  assert.deepEqual(JSON.parse(rawJob), {
    schema_version: 1,
    kind: "permission",
    thread_id: "main-thread",
    turn_id: "",
    notification_thread_id: "main-thread",
    cwd_name: "example",
  });
  assert.deepEqual(await auditEvents(paths), []);
});

test("permission background delivery pushes once, audits, and removes job", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const hookInput = {
    session_id: "main-thread",
    cwd: "/tmp/example",
  };
  let jobPath = "";
  await schedulePermissionNotification(hookInput, paths, {
    spawn: (_node, arguments_) => {
      jobPath = arguments_[2];
      return {};
    },
  });
  let pushed = null;
  await deliverPermissionJob(jobPath, paths, {
    pushBark: async (notification) => {
      await assert.rejects(lstat(jobPath), { code: "ENOENT" });
      pushed = notification;
    },
  });

  assert.deepEqual(pushed, {
    title: "🔐 [example]需要你批准",
    body: "💬example",
    url: "https://chatgpt.com/codex/tasks/main-thread",
  });
  await assert.rejects(lstat(jobPath), { code: "ENOENT" });
  assert.deepEqual(
    (await auditEvents(paths)).map((record) => record.event),
    ["permission_sent"],
  );
});

test("subagent permission opens the parent task in Codex Remote", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const childTranscript = join(
    paths.sessionRoot,
    "rollout-child-child-thread.jsonl",
  );
  await writeFile(
    childTranscript,
    jsonl({
      type: "session_meta",
      payload: {
        id: "child-thread",
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: "parent-thread" },
          },
        },
      },
    }),
  );
  await writeFile(
    join(paths.sessionRoot, "rollout-parent-parent-thread.jsonl"),
    jsonl(
      { type: "session_meta", payload: { id: "parent-thread" } },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "发布 Codex Remote 跳转",
        },
      },
    ),
  );
  await writeFile(
    paths.sessionIndex,
    jsonl({
      id: "parent-thread",
      thread_name: "Remote 跳转",
    }),
  );

  let jobPath = "";
  await schedulePermissionNotification(
    {
      session_id: "child-thread",
      transcript_path: childTranscript,
      cwd: "/tmp/example",
    },
    paths,
    {
      spawn: (_node, arguments_) => {
        jobPath = arguments_[2];
        return {};
      },
    },
  );
  assert.deepEqual(JSON.parse(await readFile(jobPath, "utf8")), {
    schema_version: 1,
    kind: "permission",
    thread_id: "child-thread",
    turn_id: "",
    notification_thread_id: "parent-thread",
    cwd_name: "example",
  });

  let pushed = null;
  await deliverPermissionJob(jobPath, paths, {
    pushBark: async (notification) => {
      pushed = notification;
    },
  });
  assert.deepEqual(pushed, {
    title: "🔐 [Remote 跳转]需要你批准",
    body: "💬发布 Codex Remote 跳转",
    url: "https://chatgpt.com/codex/tasks/parent-thread",
  });
});

test("permission spawn failure removes its job and records sanitized failure", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const result = await schedulePermissionNotification(
    { session_id: "thread", cwd: "/tmp/example" },
    paths,
    {
      spawn: () => {
        const error = new Error("spawn secret command failed");
        error.code = "EIO";
        throw error;
      },
    },
  );
  assert.deepEqual(result, { outcome: "failed_to_schedule" });
  assert.deepEqual(await readdir(paths.jobsDirectory), []);
  const [audit] = await auditEvents(paths);
  assert.equal(audit.event, "permission_failed");
  assert.equal(audit.reason, "filesystem_error");
  assert.doesNotMatch(JSON.stringify(audit), /secret command/u);
});
