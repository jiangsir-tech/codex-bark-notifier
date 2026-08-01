import { readFile } from "node:fs/promises";

import { DEFAULT_RUNTIME_CONFIG } from "./paths.mjs";
import { parseJson, sanitizeNotificationText } from "./text.mjs";

const CODEX_REMOTE_URL_PREFIX = "https://chatgpt.com/codex/tasks/";

function safeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function redactExactDeviceKey(value, deviceKey) {
  const candidate = String(value ?? "");
  const secret = String(deviceKey ?? "");
  return secret ? candidate.split(secret).join("[已隐藏]") : candidate;
}

const INSECURE_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export function validateBarkEndpoint(
  rawEndpoint,
  { allowInsecureLoopback = false } = {},
) {
  const endpoint = String(rawEndpoint ?? "").trim();
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("The Bark endpoint must be a valid HTTPS URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The Bark endpoint must not contain URL credentials.");
  }
  if (parsed.protocol === "https:") {
    return endpoint;
  }
  if (
    parsed.protocol === "http:" &&
    allowInsecureLoopback === true &&
    INSECURE_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    return endpoint;
  }
  if (parsed.protocol === "http:" && allowInsecureLoopback === true) {
    throw new Error(
      "Insecure Bark HTTP is allowed only for loopback hosts: localhost, 127.0.0.1, or ::1.",
    );
  }
  throw new Error(
    "The Bark endpoint must use HTTPS; insecure loopback HTTP requires allowInsecureLoopback: true.",
  );
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
  const allowInsecureLoopback = bark.allowInsecureLoopback === true;
  const barkEndpoint = validateBarkEndpoint(
    safeString(
      bark.endpoint ?? bark.barkEndpoint,
      DEFAULT_RUNTIME_CONFIG.barkEndpoint,
    ),
    { allowInsecureLoopback },
  );
  return {
    barkEndpoint,
    allowInsecureLoopback,
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
      redactExactDeviceKey(notification.title, deviceKey),
      "通知内容已隐藏",
    ),
    body: sanitizeNotificationText(
      redactExactDeviceKey(notification.body, deviceKey),
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
  const barkEndpoint = validateBarkEndpoint(runtimeConfig.barkEndpoint, {
    allowInsecureLoopback: runtimeConfig.allowInsecureLoopback === true,
  });
  const deviceKey = String(await read(paths.keyFile, "utf8")).trim();
  if (!deviceKey) {
    const error = new Error("Bark device key is empty");
    error.code = "KEY_MISSING";
    throw error;
  }

  const response = await request(barkEndpoint, {
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
