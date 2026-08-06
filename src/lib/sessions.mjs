import { createReadStream } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

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

const REVERSE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 16 * 1024 * 1024;

function transcriptRoots(sessionRoot) {
  return [sessionRoot, join(dirname(sessionRoot), "archived_sessions")].filter(
    (root, index, roots) => root && roots.indexOf(root) === index,
  );
}

async function readableTranscriptPath(transcriptPath) {
  if (!transcriptPath) {
    return "";
  }

  let handle;
  try {
    handle = await open(transcriptPath, "r");
    return (await handle.stat()).isFile() ? transcriptPath : "";
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function transcriptPathFromPayload(payload, threadId, sessionRoot) {
  const preferredPath = await readableTranscriptPath(
    typeof payload?.transcript_path === "string"
      ? payload.transcript_path
      : "",
  );
  return (
    preferredPath ||
    (await sessionPathForThreadId(threadId, sessionRoot))
  );
}

async function* transcriptLinesReverse(
  transcriptPath,
  {
    chunkBytes = REVERSE_READ_CHUNK_BYTES,
    maxLineBytes = MAX_TRANSCRIPT_LINE_BYTES,
  } = {},
) {
  const handle = await open(transcriptPath, "r");
  try {
    let position = (await handle.stat()).size;
    let lineParts = [];
    let lineBytes = 0;
    let skipLine = false;

    function addEarlierPart(part) {
      if (skipLine || part.length === 0) {
        return;
      }
      lineBytes += part.length;
      if (lineBytes > maxLineBytes) {
        lineParts = [];
        lineBytes = 0;
        skipLine = true;
        return;
      }
      lineParts.push(Buffer.from(part));
    }

    function finishLine() {
      if (skipLine) {
        lineParts = [];
        lineBytes = 0;
        skipLine = false;
        return null;
      }

      const line =
        lineParts.length === 0
          ? Buffer.alloc(0)
          : Buffer.concat(lineParts.reverse(), lineBytes);
      lineParts = [];
      lineBytes = 0;
      const end = line.at(-1) === 13 ? line.length - 1 : line.length;
      return line.toString("utf8", 0, end);
    }

    while (position > 0) {
      const bytesToRead = Math.min(chunkBytes, position);
      position -= bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(
        chunk,
        0,
        bytesToRead,
        position,
      );
      const data = bytesRead === chunk.length
        ? chunk
        : chunk.subarray(0, bytesRead);
      let segmentEnd = data.length;

      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 10) {
          continue;
        }
        addEarlierPart(data.subarray(index + 1, segmentEnd));
        const line = finishLine();
        if (line !== null) {
          yield line;
        }
        segmentEnd = index;
      }
      addEarlierPart(data.subarray(0, segmentEnd));
    }

    const firstLine = finishLine();
    if (firstLine !== null) {
      yield firstLine;
    }
  } finally {
    await handle.close();
  }
}

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

  const suffix = `-${threadId}.jsonl`;
  for (const root of transcriptRoots(sessionRoot)) {
    try {
      const sessionFiles = await readdir(root, { recursive: true });
      const sessionFile = sessionFiles.find(
        (entry) =>
          typeof entry === "string" &&
          basename(entry).endsWith(suffix),
      );
      if (sessionFile) {
        return join(root, sessionFile);
      }
    } catch {
      // Try the active/archive fallback root below.
    }
  }
  return "";
}

export async function sessionMetaFromTranscript(
  transcriptPath,
  threadId = "",
  allowAnySessionMetaFallback = false,
) {
  if (!transcriptPath) {
    return null;
  }

  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const rows = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const row of rows) {
      if (!row.trim()) {
        continue;
      }
      const record = parseJson(row);
      if (record?.type !== "session_meta") {
        continue;
      }
      if (!threadId || record?.payload?.id === threadId) {
        return record.payload;
      }
      return allowAnySessionMetaFallback ? record.payload : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    rows.close();
    input.destroy();
  }
}

export async function threadKind(payload, paths) {
  const { threadId } = payloadIds(payload);
  const preferredPath = await readableTranscriptPath(
    typeof payload?.transcript_path === "string"
      ? payload.transcript_path
      : "",
  );
  if (preferredPath) {
    const preferredMeta = await sessionMetaFromTranscript(
      preferredPath,
      threadId,
    );
    const preferredKind = classifySessionMetaPayload(
      preferredMeta,
      threadId,
    );
    if (preferredKind !== "unknown") {
      return preferredKind;
    }
  }

  const fallbackPath = await sessionPathForThreadId(
    threadId,
    paths.sessionRoot,
  );
  if (!fallbackPath || fallbackPath === preferredPath) {
    return "unknown";
  }
  const fallbackMeta = await sessionMetaFromTranscript(
    fallbackPath,
    threadId,
  );
  return classifySessionMetaPayload(fallbackMeta, threadId);
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
  const currentTranscript = await transcriptPathFromPayload(
    payload,
    threadId,
    paths.sessionRoot,
  );
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
    for await (const row of transcriptLinesReverse(transcriptPath)) {
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
      for await (const row of transcriptLinesReverse(transcriptPath)) {
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
