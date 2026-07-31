import { readFile } from "node:fs/promises";

import { DEFAULT_RUNTIME_CONFIG } from "./paths.mjs";
import { parseJson, sanitizeNotificationText } from "./text.mjs";

const CODEX_REMOTE_URL_PREFIX = "https://chatgpt.com/codex/tasks/";

function safeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function codexRemoteUrl(threadId) {
  const candidate = String(threadId ?? "").trim();
  if (!candidate || Array.from(candidate).length > 200) {
    return "";
  }
  try {
    return `${CODEX_REMOTE_URL_PREFIX}${encodeURIComponent(candidate)}`;
  } catch {
    return "";
  }
}

function safeCodexRemoteUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const taskId = url.pathname.slice("/codex/tasks/".length);
    if (
      url.origin !== "https://chatgpt.com" ||
      !url.pathname.startsWith("/codex/tasks/") ||
      !taskId ||
      taskId.includes("/") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

export async function loadRuntimeConfig(paths) {
  let configured = {};
  try {
    configured = parseJson(await readFile(paths.configFile, "utf8"));
  } catch {
    configured = {};
  }

  const bark =
    configured?.bark && typeof configured.bark === "object"
      ? configured.bark
      : configured;
  const timeout = Number(bark.requestTimeoutMilliseconds);
  return {
    barkEndpoint: safeString(
      bark.endpoint ?? bark.barkEndpoint,
      DEFAULT_RUNTIME_CONFIG.barkEndpoint,
    ),
    barkIconUrl: safeString(
      bark.icon ?? bark.barkIconUrl,
      DEFAULT_RUNTIME_CONFIG.barkIconUrl,
    ),
    group: safeString(bark.group, DEFAULT_RUNTIME_CONFIG.group),
    sound: safeString(bark.sound, DEFAULT_RUNTIME_CONFIG.sound),
    requestTimeoutMilliseconds:
      Number.isFinite(timeout) && timeout >= 1_000 && timeout <= 30_000
        ? timeout
        : DEFAULT_RUNTIME_CONFIG.requestTimeoutMilliseconds,
  };
}

export function buildBarkRequestPayload(
  deviceKey,
  notification,
  runtimeConfig = DEFAULT_RUNTIME_CONFIG,
) {
  const payload = {
    device_key: deviceKey,
    title: sanitizeNotificationText(
      notification.title,
      "通知内容已隐藏",
    ),
    body: sanitizeNotificationText(
      notification.body,
      "💬内容含本机路径",
    ),
    group: runtimeConfig.group,
    sound: runtimeConfig.sound,
  };
  if (runtimeConfig.barkIconUrl) {
    payload.icon = runtimeConfig.barkIconUrl;
  }
  const notificationUrl = safeCodexRemoteUrl(notification.url);
  if (notificationUrl) {
    payload.url = notificationUrl;
  }
  return payload;
}

export async function pushBark(notification, paths, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  const request = dependencies.fetch ?? fetch;
  const runtimeConfig =
    dependencies.runtimeConfig ?? (await loadRuntimeConfig(paths));
  const deviceKey = String(await read(paths.keyFile, "utf8")).trim();
  if (!deviceKey) {
    const error = new Error("Bark device key is empty");
    error.code = "KEY_MISSING";
    throw error;
  }

  const response = await request(runtimeConfig.barkEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(
      buildBarkRequestPayload(deviceKey, notification, runtimeConfig),
    ),
    signal: AbortSignal.timeout(runtimeConfig.requestTimeoutMilliseconds),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 200) {
    throw new Error(`Bark rejected the push (${response.status})`);
  }
}
