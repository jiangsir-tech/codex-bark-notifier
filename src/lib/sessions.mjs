import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  normalizeTaskName,
  notificationBodyFromAssistantReply,
  parseJson,
  payloadIds,
  shortenConversationName,
  textFromAssistantMessage,
  textFromUserMessage,
} from "./text.mjs";

export const THREAD_KIND_RETRY_DELAYS = Object.freeze([
  500,
  1_000,
  2_000,
  4_000,
]);

export function classifySessionMetaPayload(metaPayload, threadId = "") {
  if (!metaPayload || (threadId && metaPayload.id !== threadId)) {
    return "unknown";
  }

  if (
    metaPayload.parent_thread_id ||
    metaPayload?.source?.subagent ||
    metaPayload?.source?.subagent?.thread_spawn?.parent_thread_id
  ) {
    return "subagent";
  }
  return "main";
}

export function parentThreadIdFromSessionMeta(metaPayload) {
  return String(
    metaPayload?.source?.subagent?.thread_spawn?.parent_thread_id ??
      metaPayload?.parent_thread_id ??
      "",
  );
}

export async function sessionPathForThreadId(threadId, sessionRoot) {
  if (!threadId || /[/\\\0]/u.test(threadId)) {
    return "";
  }

  try {
    const sessionFiles = await readdir(sessionRoot, { recursive: true });
    const suffix = `-${threadId}.jsonl`;
    const sessionFile = sessionFiles.find(
      (entry) =>
        typeof entry === "string" &&
        basename(entry).endsWith(suffix),
    );
    return sessionFile ? join(sessionRoot, sessionFile) : "";
  } catch {
    return "";
  }
}

export async function sessionMetaFromTranscript(
  transcriptPath,
  threadId = "",
  allowAnySessionMetaFallback = false,
) {
  if (!transcriptPath) {
    return null;
  }

  try {
    const rows = (await readFile(transcriptPath, "utf8")).split(/\r?\n/u);
    let fallbackMeta = null;
    for (const row of rows) {
      if (!row.trim()) {
        continue;
      }
      const record = parseJson(row);
      if (record?.type !== "session_meta") {
        continue;
      }
      fallbackMeta ??= record.payload;
      if (!threadId || record?.payload?.id === threadId) {
        return record.payload;
      }
    }
    return allowAnySessionMetaFallback ? fallbackMeta : null;
  } catch {
    return null;
  }
}

export async function threadKind(payload, paths) {
  const { threadId } = payloadIds(payload);
  const transcriptPath =
    payload?.transcript_path ||
    (await sessionPathForThreadId(threadId, paths.sessionRoot));
  const meta = await sessionMetaFromTranscript(transcriptPath, threadId);
  return classifySessionMetaPayload(meta, threadId);
}

export async function resolvedThreadKind(
  payload,
  paths,
  {
    retryDelays = THREAD_KIND_RETRY_DELAYS,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  let kind = await threadKind(payload, paths);
  if (kind !== "unknown") {
    return kind;
  }

  for (const retryDelay of retryDelays) {
    await sleep(retryDelay);
    kind = await threadKind(payload, paths);
    if (kind !== "unknown") {
      return kind;
    }
  }
  return "unknown";
}

export async function parentThreadIdFromTranscript(transcriptPath, threadId) {
  // PermissionRequest may report the parent session id while transcript_path
  // points at the requesting subagent. Prefer an exact id, then trust the
  // transcript's own session_meta as the fallback source of parent linkage.
  const meta = await sessionMetaFromTranscript(transcriptPath, threadId, true);
  return parentThreadIdFromSessionMeta(meta);
}

export async function taskNameFromIndex(
  notificationThreadId,
  sessionIndex,
  cwd = "",
) {
  if (notificationThreadId) {
    try {
      const rows = (await readFile(sessionIndex, "utf8"))
        .split(/\r?\n/u)
        .reverse();
      for (const row of rows) {
        if (!row.trim()) {
          continue;
        }
        const record = parseJson(row);
        if (
          record?.id === notificationThreadId &&
          typeof record?.thread_name === "string" &&
          record.thread_name.trim()
        ) {
          return normalizeTaskName(record.thread_name, cwd);
        }
      }
    } catch {
      // Use the working-directory fallback below.
    }
  }
  return normalizeTaskName("", cwd);
}

export async function notificationContext(payload, paths) {
  const { threadId } = payloadIds(payload);
  const currentTranscript =
    payload?.transcript_path ||
    (await sessionPathForThreadId(threadId, paths.sessionRoot));
  const parentThreadId = await parentThreadIdFromTranscript(
    currentTranscript,
    threadId,
  );
  const notificationThreadId = parentThreadId || threadId;
  const parentTranscript = parentThreadId
    ? await sessionPathForThreadId(parentThreadId, paths.sessionRoot)
    : "";

  return {
    threadId,
    parentThreadId,
    notificationThreadId,
    currentTranscript,
    notificationTranscript: parentTranscript || currentTranscript,
  };
}

export async function taskNameFromPayload(payload, paths) {
  const context = await notificationContext(payload, paths);
  return taskNameFromIndex(
    context.notificationThreadId,
    paths.sessionIndex,
    payload?.cwd,
  );
}

export async function conversationNameFromTranscript(
  transcriptPath,
  cwd = "",
) {
  if (!transcriptPath) {
    return shortenConversationName("", cwd);
  }

  try {
    const rows = (await readFile(transcriptPath, "utf8"))
      .split(/\r?\n/u)
      .reverse();
    for (const row of rows) {
      if (!row.trim()) {
        continue;
      }
      const record = parseJson(row);
      const text = textFromUserMessage(record);
      if (
        text &&
        !text.trimStart().startsWith("<environment_context>") &&
        !text.trimStart().startsWith("<permissions instructions>")
      ) {
        return shortenConversationName(text, cwd);
      }
    }
  } catch {
    // Use the working-directory fallback below.
  }

  return shortenConversationName("", cwd);
}

export async function assistantSummaryFromTranscript(
  transcriptPath,
  turnId = "",
  fallback = "未生成摘要",
  {
    retryDelays = [150, 300],
    status,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const safeFallback = notificationBodyFromAssistantReply(
    "",
    status,
    fallback,
  );
  if (!transcriptPath || !turnId) {
    return safeFallback;
  }

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const rows = (await readFile(transcriptPath, "utf8"))
        .split(/\r?\n/u)
        .reverse();
      for (const row of rows) {
        if (!row.trim()) {
          continue;
        }
        const record = parseJson(row);
        const payload = record?.payload ?? {};
        if (
          record?.type !== "event_msg" ||
          payload?.type !== "task_complete" ||
          String(payload?.turn_id ?? "") !== turnId
        ) {
          continue;
        }
        const text = textFromAssistantMessage(record);
        return text.trim()
          ? notificationBodyFromAssistantReply(text, status, fallback)
          : safeFallback;
      }
    } catch {
      // The transcript may still be appearing; retry below.
    }

    if (attempt < retryDelays.length) {
      await sleep(retryDelays[attempt]);
    }
  }

  return safeFallback;
}
