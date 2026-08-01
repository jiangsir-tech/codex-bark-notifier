#!/usr/bin/env node

import { spawn } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { codexRemoteUrl, pushBark } from "./lib/bark.mjs";
import { runtimePaths } from "./lib/paths.mjs";
import {
  assistantSummaryFromTranscript,
  conversationNameFromTranscript,
  notificationContext,
  resolvedThreadKind,
  sessionPathForThreadId,
  taskNameFromIndex,
  THREAD_KIND_RETRY_DELAYS,
} from "./lib/sessions.mjs";
import {
  acquireEventLock,
  cleanupStaleJobs,
  consumePrivateJob,
  createPrivateJob,
  lockForPayload,
  markEventSent,
  releaseEventLock,
  removeIfPresent,
  safeErrorReason,
  writeAudit,
} from "./lib/state.mjs";
import {
  classifyLastReply,
  completionDelayMilliseconds,
  conversationNameFromPayload,
  formatNotification,
  notificationBodyFromAssistantReply,
  parseJson,
  payloadIds,
} from "./lib/text.mjs";

export const PATHS = runtimePaths(import.meta.url);

const TURN_STATUS_BY_CODE = Object.freeze({
  complete: Object.freeze({ icon: "✅", label: "本轮结束" }),
  reply: Object.freeze({ icon: "🔁", label: "需要你回复" }),
  error: Object.freeze({ icon: "⛔", label: "受阻或出错" }),
});

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withCodexRemoteUrl(notification, threadId) {
  const url = codexRemoteUrl(threadId);
  return url ? { ...notification, url } : notification;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

async function cliPayload(argument) {
  if (argument) {
    return parseJson(argument);
  }
  const input = await readStdin();
  return parseJson(input);
}

export async function buildTurnNotification(payload, paths = PATHS) {
  const context = await notificationContext(payload, paths);
  const taskName = await taskNameFromIndex(
    context.notificationThreadId,
    paths.sessionIndex,
    payload?.cwd,
  );
  const conversationName = conversationNameFromPayload(payload);
  const status = classifyLastReply(payload?.["last-assistant-message"]);
  const answerSummary = notificationBodyFromAssistantReply(
    payload?.["last-assistant-message"],
    status,
    conversationName,
  );
  return withCodexRemoteUrl(
    formatNotification(status, taskName, answerSummary),
    context.notificationThreadId,
  );
}

export async function buildPermissionNotification(payload, paths = PATHS) {
  const context = await notificationContext(payload, paths);
  const taskName = await taskNameFromIndex(
    context.notificationThreadId,
    paths.sessionIndex,
    payload?.cwd,
  );
  const conversationName = await conversationNameFromTranscript(
    context.notificationTranscript,
    payload?.cwd,
  );
  return withCodexRemoteUrl(
    formatNotification(
      { icon: "🔐", label: "需要你批准" },
      taskName,
      conversationName,
    ),
    context.notificationThreadId,
  );
}

function turnStatusCode(lastReply) {
  const { label } = classifyLastReply(lastReply);
  if (label === "需要你回复") {
    return "reply";
  }
  if (label === "受阻或出错") {
    return "error";
  }
  return "complete";
}

async function buildReferencedNotification(job, status, paths) {
  const transcriptPath = await sessionPathForThreadId(
    job.notification_thread_id,
    paths.sessionRoot,
  );
  const [taskName, conversationName] = await Promise.all([
    taskNameFromIndex(
      job.notification_thread_id,
      paths.sessionIndex,
      job.cwd_name,
    ),
    conversationNameFromTranscript(transcriptPath, job.cwd_name),
  ]);
  const bodyText =
    job.kind === "turn"
      ? await assistantSummaryFromTranscript(
          transcriptPath,
          job.turn_id,
          conversationName,
          { status },
        )
      : conversationName;
  return withCodexRemoteUrl(
    formatNotification(status, taskName, bodyText),
    job.notification_thread_id,
  );
}

export async function handlePermissionRequest(
  hookInput,
  paths = PATHS,
  dependencies = {},
) {
  try {
    const notification = await buildPermissionNotification(hookInput, paths);
    await (dependencies.pushBark ?? pushBark)(
      notification,
      paths,
      dependencies,
    );
    await writeAudit(paths, hookInput, "permission_sent");
  } catch (error) {
    await writeAudit(paths, hookInput, "permission_failed", {
      reason: safeErrorReason(error),
    });
    throw error;
  }
}

export async function deliverPermissionJob(
  jobPath,
  paths = PATHS,
  dependencies = {},
) {
  let payload = {};
  try {
    payload = await consumePrivateJob(jobPath, paths);
    if (payload.kind !== "permission") {
      throw Object.assign(new Error("Unexpected private job kind"), {
        code: "EINVAL",
      });
    }
    const notification = await buildReferencedNotification(
      payload,
      { icon: "🔐", label: "需要你批准" },
      paths,
    );
    await (dependencies.pushBark ?? pushBark)(
      notification,
      paths,
      dependencies,
    );
    await writeAudit(paths, payload, "permission_sent");
  } catch (error) {
    await writeAudit(paths, payload, "permission_failed", {
      reason: safeErrorReason(error),
    });
    throw error;
  } finally {
    await removeIfPresent(jobPath).catch(() => {});
  }
}

export async function schedulePermissionNotification(
  hookInput,
  paths = PATHS,
  dependencies = {},
) {
  let jobPath = "";
  try {
    const { threadId, turnId } = payloadIds(hookInput);
    const context = await notificationContext(hookInput, paths);
    jobPath = await createPrivateJob(
      {
        schema_version: 1,
        kind: "permission",
        thread_id: threadId,
        turn_id: turnId,
        notification_thread_id: context.notificationThreadId,
        cwd_name: basename(hookInput?.cwd || ""),
      },
      paths,
    );
    const launch = dependencies.spawn ?? spawn;
    const child = launch(
      process.execPath,
      [paths.entryPath, "--deliver-permission-job", jobPath],
      { detached: true, stdio: "ignore" },
    );
    if (!dependencies.spawn) {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    }
    return { outcome: "scheduled" };
  } catch (error) {
    if (jobPath) {
      await removeIfPresent(jobPath).catch(() => {});
    }
    await writeAudit(paths, hookInput, "permission_failed", {
      reason: safeErrorReason(error),
    });
    return { outcome: "failed_to_schedule" };
  }
}

export async function deliverTurnJob(
  jobPath,
  paths = PATHS,
  dependencies = {},
) {
  let payload = {};
  let lock = null;
  try {
    payload = await consumePrivateJob(jobPath, paths);
    if (payload.kind !== "turn") {
      throw Object.assign(new Error("Unexpected private job kind"), {
        code: "EINVAL",
      });
    }
    lock = lockForPayload(payload, paths);
    const delayMilliseconds = payload.delay_ms;
    await (dependencies.sleep ?? sleep)(delayMilliseconds);
    const notification = await buildReferencedNotification(
      payload,
      TURN_STATUS_BY_CODE[payload.status],
      paths,
    );
    await (dependencies.pushBark ?? pushBark)(
      notification,
      paths,
      dependencies,
    );
    await markEventSent(lock);
    await writeAudit(paths, payload, "sent", {
      delay_ms: delayMilliseconds,
    });
  } catch (error) {
    await releaseEventLock(lock);
    await writeAudit(paths, payload, "failed", {
      reason: safeErrorReason(error),
    });
  } finally {
    await removeIfPresent(jobPath).catch(() => {});
  }
}

export async function scheduleTurnNotification(
  payload,
  paths = PATHS,
  dependencies = {},
) {
  if (payload?.type && payload.type !== "agent-turn-complete") {
    return { outcome: "ignored_event" };
  }

  const kind = await (dependencies.resolvedThreadKind ?? resolvedThreadKind)(
    payload,
    paths,
    dependencies,
  );
  if (kind === "subagent") {
    await writeAudit(paths, payload, "suppressed_subagent");
    return { outcome: "suppressed_subagent" };
  }
  if (kind === "unknown") {
    await writeAudit(paths, payload, "suppressed_unknown", {
      retries: THREAD_KIND_RETRY_DELAYS.length,
    });
    return { outcome: "suppressed_unknown" };
  }

  const lock = await acquireEventLock(payload, paths);
  if (lock.duplicate) {
    await writeAudit(paths, payload, "suppressed_duplicate");
    return { outcome: "suppressed_duplicate" };
  }

  const delayMilliseconds = completionDelayMilliseconds(payload);
  await writeAudit(paths, payload, "scheduled", {
    thread_kind: kind,
    delay_ms: delayMilliseconds,
  });

  let jobPath = "";
  try {
    const { threadId, turnId } = payloadIds(payload);
    jobPath = await createPrivateJob(
      {
        schema_version: 1,
        kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        notification_thread_id: threadId,
        cwd_name: basename(payload?.cwd || ""),
        status: turnStatusCode(payload?.["last-assistant-message"]),
        delay_ms: delayMilliseconds,
      },
      paths,
    );
    const launch = dependencies.spawn ?? spawn;
    const child = launch(
      process.execPath,
      [paths.entryPath, "--deliver-job", jobPath],
      { detached: true, stdio: "ignore" },
    );
    if (!dependencies.spawn) {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    }
    return { outcome: "scheduled", delayMilliseconds };
  } catch (error) {
    if (jobPath) {
      await removeIfPresent(jobPath).catch(() => {});
    }
    await releaseEventLock(lock);
    await writeAudit(paths, payload, "failed_to_schedule", {
      reason: safeErrorReason(error),
    });
    return { outcome: "failed_to_schedule" };
  }
}

export async function main(argv = process.argv.slice(2)) {
  await cleanupStaleJobs(PATHS).catch(() => {});
  const mode = argv[0];

  if (mode === "--permission") {
    const payload = parseJson(await readStdin());
    await schedulePermissionNotification(payload);
    return;
  }

  if (mode === "--deliver-permission-job") {
    await deliverPermissionJob(argv[1] ?? "");
    return;
  }

  if (mode === "--deliver-job") {
    await deliverTurnJob(argv[1] ?? "");
    return;
  }

  if (mode === "--inspect-thread") {
    const payload = { "thread-id": argv[1] ?? "" };
    console.log(await resolvedThreadKind(payload, PATHS));
    return;
  }

  if (mode === "--route-preview") {
    const payload = await cliPayload(argv[1]);
    console.log(
      JSON.stringify({
        thread_kind: await resolvedThreadKind(payload, PATHS),
        delay_ms: completionDelayMilliseconds(payload),
        notification: await buildTurnNotification(payload),
      }),
    );
    return;
  }

  if (mode === "--preview") {
    console.log(
      JSON.stringify(
        await buildTurnNotification(await cliPayload(argv[1])),
      ),
    );
    return;
  }

  if (mode === "--permission-preview") {
    console.log(
      JSON.stringify(
        await buildPermissionNotification(await cliPayload(argv[1])),
      ),
    );
    return;
  }

  if (mode === "--bark-only" || mode === "--test") {
    await pushBark(
      {
        title: "✅ [Bark 测试]本轮结束",
        body: "💬Codex Bark Notifier 配置成功",
      },
      PATHS,
    );
    return;
  }

  await scheduleTurnNotification(parseJson(mode));
}

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectExecution) {
  await main();
}
