import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  acquireEventLock,
  cleanupStaleJobs,
  consumePrivateJob,
  createPrivateJob,
  eventKey,
  markEventSent,
  readPrivateJob,
  releaseEventLock,
  writeAudit,
} from "../src/lib/state.mjs";
import {
  removeTemporaryPaths,
  temporaryPaths,
} from "./helpers.mjs";

function permissions(mode) {
  return mode & 0o777;
}

test("event lock deduplicates, marks sent, and releases safely", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const payload = { "thread-id": "thread", "turn-id": "turn" };
  assert.match(eventKey(payload), /^[0-9a-f]{64}$/u);

  const first = await acquireEventLock(payload, paths);
  assert.equal(first.duplicate, false);
  assert.equal(permissions((await lstat(paths.stateDirectory)).mode), 0o700);
  assert.equal(permissions((await lstat(first.lockPath)).mode), 0o600);

  const duplicate = await acquireEventLock(payload, paths);
  assert.equal(duplicate.duplicate, true);
  await markEventSent(first);
  assert.equal((await lstat(first.sentPath)).isFile(), true);
  assert.equal((await acquireEventLock(payload, paths)).duplicate, true);

  const other = await acquireEventLock(
    { "thread-id": "thread", "turn-id": "other" },
    paths,
  );
  await releaseEventLock(other);
  await assert.rejects(lstat(other.lockPath), { code: "ENOENT" });
});

test("a stale lock is recovered exactly once", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const payload = { "thread-id": "thread", "turn-id": "stale" };
  const first = await acquireEventLock(payload, paths);
  const old = new Date(Date.now() - 10_000);
  await utimes(first.lockPath, old, old);

  const recovered = await acquireEventLock(payload, paths, {
    staleLockMilliseconds: 1_000,
  });
  assert.equal(recovered.duplicate, false);
  assert.equal((await lstat(recovered.lockPath)).isFile(), true);
});

test("private jobs use 0700 directory and 0600 regular files", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const job = {
    schema_version: 2,
    kind: "turn",
    thread_id: "thread",
    turn_id: "turn",
    notification_thread_id: "thread",
    cwd_name: "project",
    request_name: "整理通知任务",
    status: "complete",
    delay_ms: 5_000,
  };
  const jobPath = await createPrivateJob(job, paths);
  assert.equal(permissions((await lstat(paths.jobsDirectory)).mode), 0o700);
  assert.equal(permissions((await lstat(jobPath)).mode), 0o600);
  assert.deepEqual(await readPrivateJob(jobPath, paths), job);
});

test("private job schema rejects arbitrary payload fields before writing", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await assert.rejects(
    createPrivateJob(
      {
        schema_version: 1,
        kind: "permission",
        thread_id: "thread",
        turn_id: "",
        notification_thread_id: "thread",
        cwd_name: "project",
        tool_input: { cmd: "PRIVATE_TOOL_ARGUMENT" },
      },
      paths,
    ),
    { code: "EINVAL" },
  );
  await assert.rejects(lstat(paths.jobsDirectory), { code: "ENOENT" });
});

test("private job schema accepts legacy jobs and bounds the captured request name", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const legacyJob = {
    schema_version: 1,
    kind: "turn",
    thread_id: "thread",
    turn_id: "turn",
    notification_thread_id: "thread",
    cwd_name: "project",
    status: "complete",
    delay_ms: 5_000,
  };
  const legacyPath = await createPrivateJob(legacyJob, paths);
  assert.deepEqual(await readPrivateJob(legacyPath, paths), legacyJob);

  await assert.rejects(
    createPrivateJob(
      {
        ...legacyJob,
        schema_version: 2,
        request_name: "x".repeat(129),
      },
      paths,
    ),
    { code: "EINVAL" },
  );
  await assert.rejects(
    createPrivateJob(
      {
        ...legacyJob,
        schema_version: 2,
        request_name: "Bark Device Key 为 testKey123456",
      },
      paths,
    ),
    { code: "EINVAL" },
  );
});

test("consuming a private job unlinks it before returning", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const job = {
    schema_version: 1,
    kind: "permission",
    thread_id: "thread",
    turn_id: "",
    notification_thread_id: "thread",
    cwd_name: "project",
  };
  const jobPath = await createPrivateJob(job, paths);
  assert.deepEqual(await consumePrivateJob(jobPath, paths), job);
  await assert.rejects(lstat(jobPath), { code: "ENOENT" });
});

test("private job schema cannot be bypassed with inherited toJSON", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const job = Object.assign(
    Object.create({
      toJSON() {
        return { raw_secret: "SCHEMA_BYPASS_SECRET" };
      },
    }),
    {
      schema_version: 1,
      kind: "permission",
      thread_id: "thread",
      turn_id: "",
      notification_thread_id: "thread",
      cwd_name: "project",
    },
  );
  await assert.rejects(createPrivateJob(job, paths), { code: "EINVAL" });
  await assert.rejects(lstat(paths.jobsDirectory), { code: "ENOENT" });
});

test("consuming a malformed managed job deletes it before rejecting", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await mkdir(paths.jobsDirectory, { recursive: true, mode: 0o700 });
  const jobPath = join(
    paths.jobsDirectory,
    "44444444-4444-4444-8444-444444444444.json",
  );
  await writeFile(
    jobPath,
    JSON.stringify({
      kind: "permission",
      tool_input: { cmd: "MALFORMED_PRIVATE_ARGUMENT" },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(consumePrivateJob(jobPath, paths), { code: "EINVAL" });
  await assert.rejects(lstat(jobPath), { code: "ENOENT" });
});

test("job reader rejects arbitrary paths and symlinks", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await mkdir(paths.jobsDirectory, { recursive: true });
  const outside = join(paths.root, "outside.json");
  await writeFile(outside, '{"outside":true}');
  await assert.rejects(readPrivateJob(outside, paths), { code: "EPERM" });

  const symlinkPath = join(
    paths.jobsDirectory,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json",
  );
  await symlink(outside, symlinkPath);
  await assert.rejects(readPrivateJob(symlinkPath, paths), { code: "EPERM" });
  assert.equal(await readFile(outside, "utf8"), '{"outside":true}');
});

test("stale cleanup removes only old managed regular jobs", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  await mkdir(paths.jobsDirectory, { recursive: true });
  await chmod(paths.jobsDirectory, 0o700);
  const oldManaged = join(
    paths.jobsDirectory,
    "11111111-1111-4111-8111-111111111111.json",
  );
  const freshManaged = join(
    paths.jobsDirectory,
    "22222222-2222-4222-8222-222222222222.json",
  );
  const arbitrary = join(paths.jobsDirectory, "keep-me.json");
  const target = join(paths.root, "target.json");
  const linked = join(
    paths.jobsDirectory,
    "33333333-3333-4333-8333-333333333333.json",
  );
  await Promise.all([
    writeFile(oldManaged, "{}"),
    writeFile(freshManaged, "{}"),
    writeFile(arbitrary, "{}"),
    writeFile(target, '{"safe":true}'),
  ]);
  await symlink(target, linked);
  const old = new Date(Date.now() - 10_000);
  await utimes(oldManaged, old, old);
  await utimes(arbitrary, old, old);

  assert.equal(
    await cleanupStaleJobs(paths, {
      now: Date.now(),
      staleJobMilliseconds: 1_000,
    }),
    1,
  );
  await assert.rejects(lstat(oldManaged), { code: "ENOENT" });
  assert.equal((await lstat(freshManaged)).isFile(), true);
  assert.equal((await lstat(arbitrary)).isFile(), true);
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.equal(await readFile(target, "utf8"), '{"safe":true}');
});

test("audit log excludes keys, conversation text, and arbitrary details", async (t) => {
  const paths = await temporaryPaths();
  t.after(() => removeTemporaryPaths(paths));
  const payload = {
    "thread-id": "thread",
    "turn-id": "turn",
    device_key: "SUPER-SECRET-KEY",
    "last-assistant-message": "PRIVATE ASSISTANT BODY",
    "input-messages": ["PRIVATE USER BODY"],
  };
  await writeAudit(paths, payload, "failed", {
    reason: "network_error",
    arbitrary_secret: "SHOULD NOT APPEAR",
  });
  const raw = await readFile(paths.auditLog, "utf8");
  const record = JSON.parse(raw.trim());
  assert.deepEqual(Object.keys(record), [
    "timestamp",
    "event",
    "thread_id",
    "turn_id",
    "reason",
  ]);
  assert.equal(record.reason, "network_error");
  assert.doesNotMatch(
    raw,
    /SUPER-SECRET-KEY|PRIVATE ASSISTANT BODY|PRIVATE USER BODY|SHOULD NOT APPEAR/u,
  );
  assert.equal(permissions((await lstat(paths.auditLog)).mode), 0o600);
});
