import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { payloadIds } from "./text.mjs";

export const STALE_LOCK_MILLISECONDS = 2 * 60 * 1_000;
export const STALE_JOB_MILLISECONDS = 60 * 60 * 1_000;
export const PRIVATE_JOB_SCHEMA_VERSION = 1;
const MANAGED_JOB_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

export function eventKey(payload) {
  const { threadId, turnId } = payloadIds(payload);
  if (!threadId || !turnId) {
    return "";
  }
  return createHash("sha256")
    .update(`${threadId}\u0000${turnId}`)
    .digest("hex");
}

export function isManagedJobFileName(fileName) {
  return MANAGED_JOB_NAME_PATTERN.test(String(fileName ?? ""));
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export function safeErrorReason(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("device key") || code === "KEY_MISSING") {
    return "key_missing";
  }
  if (message.includes("bark rejected")) {
    const status = message.match(/\b[1-5]\d\d\b/u)?.[0];
    return status ? `bark_rejected_${status}` : "bark_rejected";
  }
  if (
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT" ||
    message.includes("timeout")
  ) {
    return "timeout";
  }
  if (
    ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"].includes(code) ||
    message.includes("fetch failed")
  ) {
    return "network_error";
  }
  if (["EACCES", "EPERM", "ENOENT", "EIO", "ENOSPC"].includes(code)) {
    return "filesystem_error";
  }
  if (message.includes("spawn")) {
    return "spawn_error";
  }
  return "unknown_error";
}

export async function writeAudit(paths, payload, event, details = {}) {
  try {
    await ensurePrivateDirectory(paths.runtimeRoot);
    const { threadId, turnId } = payloadIds(payload);
    const record = {
      timestamp: new Date().toISOString(),
      event,
      thread_id: threadId,
      turn_id: turnId,
    };

    for (const key of [
      "thread_kind",
      "delay_ms",
      "retries",
      "reason",
    ]) {
      if (details[key] !== undefined) {
        record[key] = details[key];
      }
    }

    await appendFile(paths.auditLog, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    await chmod(paths.auditLog, 0o600);
  } catch {
    // Delivery should not fail only because audit logging failed.
  }
}

export async function acquireEventLock(
  payload,
  paths,
  {
    mayRecoverStaleLock = true,
    staleLockMilliseconds = STALE_LOCK_MILLISECONDS,
  } = {},
) {
  const key = eventKey(payload);
  if (!key) {
    return { enabled: false, duplicate: false };
  }

  await ensurePrivateDirectory(paths.stateDirectory);
  const lockPath = join(paths.stateDirectory, `${key}.lock`);
  const sentPath = join(paths.stateDirectory, `${key}.sent`);

  if (await pathExists(sentPath)) {
    return { enabled: true, duplicate: true, lockPath, sentPath };
  }

  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.close();
    return { enabled: true, duplicate: false, lockPath, sentPath };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  if (mayRecoverStaleLock) {
    try {
      const lockInfo = await stat(lockPath);
      if (Date.now() - lockInfo.mtimeMs > staleLockMilliseconds) {
        await removeIfPresent(lockPath);
        return acquireEventLock(payload, paths, {
          mayRecoverStaleLock: false,
          staleLockMilliseconds,
        });
      }
    } catch {
      return acquireEventLock(payload, paths, {
        mayRecoverStaleLock: false,
        staleLockMilliseconds,
      });
    }
  }

  return { enabled: true, duplicate: true, lockPath, sentPath };
}

export async function markEventSent(lock) {
  if (lock?.enabled && lock.lockPath && lock.sentPath) {
    await rename(lock.lockPath, lock.sentPath);
  }
}

export async function releaseEventLock(lock) {
  if (lock?.enabled && lock.lockPath) {
    await removeIfPresent(lock.lockPath);
  }
}

export function lockForPayload(payload, paths) {
  const key = eventKey(payload);
  return {
    enabled: Boolean(key),
    lockPath: key ? join(paths.stateDirectory, `${key}.lock`) : "",
    sentPath: key ? join(paths.stateDirectory, `${key}.sent`) : "",
  };
}

export async function cleanupStaleJobs(
  paths,
  {
    now = Date.now(),
    staleJobMilliseconds = STALE_JOB_MILLISECONDS,
  } = {},
) {
  await ensurePrivateDirectory(paths.jobsDirectory);
  let removed = 0;
  let entries = [];
  try {
    entries = await readdir(paths.jobsDirectory, { withFileTypes: true });
  } catch {
    return removed;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !isManagedJobFileName(entry.name)) {
        return;
      }

      const candidatePath = join(paths.jobsDirectory, entry.name);
      try {
        // lstat deliberately rejects symlinks even if the directory entry is
        // replaced between readdir and inspection. unlink would only remove a
        // raced-in symlink itself, never its target.
        const info = await lstat(candidatePath);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          now - info.mtimeMs <= staleJobMilliseconds
        ) {
          return;
        }
        await unlink(candidatePath);
        removed += 1;
      } catch {
        // Cleanup is best effort and must not prevent a new notification.
      }
    }),
  );

  return removed;
}

function invalidPrivateJob() {
  const error = new Error("Invalid private notification job");
  error.code = "EINVAL";
  return error;
}

function isBoundedString(value, maximumLength) {
  return (
    typeof value === "string" &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.length <= maximumLength
  );
}

function exactDataRecord(value, expectedKeys) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw invalidPrivateJob();
  }
  const actualKeys = Object.getOwnPropertyNames(value).sort();
  if (
    JSON.stringify(actualKeys) !==
    JSON.stringify([...expectedKeys].sort())
  ) {
    throw invalidPrivateJob();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of actualKeys) {
    if (
      !Object.hasOwn(descriptors[key], "value") ||
      !descriptors[key].enumerable
    ) {
      throw invalidPrivateJob();
    }
  }
  return Object.fromEntries(
    actualKeys.map((key) => [key, descriptors[key].value]),
  );
}

export function validatePrivateJob(job) {
  const commonKeys = [
    "cwd_name",
    "kind",
    "notification_thread_id",
    "schema_version",
    "thread_id",
    "turn_id",
  ];
  const kind = Object.getOwnPropertyDescriptor(job ?? {}, "kind")?.value;
  const expectedKeys =
    kind === "turn"
      ? [...commonKeys, "delay_ms"].sort()
          .concat("status")
      : kind === "permission"
        ? commonKeys.sort()
        : [];
  const values = exactDataRecord(job, expectedKeys);
  if (
    expectedKeys.length === 0 ||
    values.schema_version !== PRIVATE_JOB_SCHEMA_VERSION ||
    !isBoundedString(values.thread_id, 512) ||
    !isBoundedString(values.turn_id, 512) ||
    !isBoundedString(values.notification_thread_id, 512) ||
    !isBoundedString(values.cwd_name, 255) ||
    /[/\\]/u.test(values.cwd_name)
  ) {
    throw invalidPrivateJob();
  }

  if (
    values.kind === "turn" &&
    (!["complete", "reply", "error"].includes(values.status) ||
      !Number.isInteger(values.delay_ms) ||
      values.delay_ms < 5_000 ||
      values.delay_ms > 15_000 ||
      values.delay_ms % 1_000 !== 0)
  ) {
    throw invalidPrivateJob();
  }

  if (values.kind === "turn") {
    return {
      schema_version: PRIVATE_JOB_SCHEMA_VERSION,
      kind: "turn",
      thread_id: values.thread_id,
      turn_id: values.turn_id,
      notification_thread_id: values.notification_thread_id,
      cwd_name: values.cwd_name,
      status: values.status,
      delay_ms: values.delay_ms,
    };
  }
  return {
    schema_version: PRIVATE_JOB_SCHEMA_VERSION,
    kind: "permission",
    thread_id: values.thread_id,
    turn_id: values.turn_id,
    notification_thread_id: values.notification_thread_id,
    cwd_name: values.cwd_name,
  };
}

function validatedJobPath(jobPath, paths) {
  const resolvedJobPath = resolve(jobPath);
  if (
    dirname(resolvedJobPath) !== resolve(paths.jobsDirectory) ||
    !isManagedJobFileName(basename(resolvedJobPath))
  ) {
    const error = new Error("Invalid job path");
    error.code = "EPERM";
    throw error;
  }
  return resolvedJobPath;
}

export async function createPrivateJob(job, paths) {
  const canonicalJob = validatePrivateJob(job);
  await cleanupStaleJobs(paths);
  const jobPath = join(paths.jobsDirectory, `${randomUUID()}.json`);
  const handle = await open(jobPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(canonicalJob), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(jobPath, 0o600);
  return jobPath;
}

export async function readPrivateJob(jobPath, paths) {
  const resolvedJobPath = validatedJobPath(jobPath, paths);
  const info = await lstat(resolvedJobPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    const error = new Error("Job path is not a regular file");
    error.code = "EPERM";
    throw error;
  }
  return validatePrivateJob(
    JSON.parse(await readFile(resolvedJobPath, "utf8")),
  );
}

export async function consumePrivateJob(jobPath, paths) {
  const resolvedJobPath = validatedJobPath(jobPath, paths);
  let handle;
  try {
    handle = await open(
      resolvedJobPath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      error.code = "EPERM";
    }
    throw error;
  }

  try {
    const [handleInfo, pathInfo] = await Promise.all([
      handle.stat(),
      lstat(resolvedJobPath),
    ]);
    if (
      !handleInfo.isFile() ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      handleInfo.dev !== pathInfo.dev ||
      handleInfo.ino !== pathInfo.ino
    ) {
      const error = new Error("Job path is not a regular file");
      error.code = "EPERM";
      throw error;
    }
    await unlink(resolvedJobPath);
    return validatePrivateJob(
      JSON.parse(await handle.readFile("utf8")),
    );
  } finally {
    await handle.close();
  }
}
