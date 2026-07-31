import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ICON_URL =
  "https://raw.githubusercontent.com/jiangsir-tech/codex-bark-icon/c188b28641901dbc8b3497bf9d8a8222243ef811/codex-bark-icon.png";

export function resolveCodexHome(environment = process.env) {
  const configured = String(environment.CODEX_HOME ?? "").trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}

export function runtimePaths(entryUrl = import.meta.url, environment = process.env) {
  const entryPath = fileURLToPath(entryUrl);
  const runtimeRoot = dirname(entryPath);
  const codexHome = resolveCodexHome(environment);

  return {
    entryPath,
    runtimeRoot,
    codexHome,
    configFile: join(runtimeRoot, "config.json"),
    keyFile: join(runtimeRoot, "bark-device-key"),
    stateDirectory: join(runtimeRoot, "state"),
    jobsDirectory: join(runtimeRoot, "jobs"),
    auditLog: join(runtimeRoot, "bark-notify.log"),
    sessionRoot: join(codexHome, "sessions"),
    sessionIndex: join(codexHome, "session_index.jsonl"),
  };
}

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  barkEndpoint: "https://api.day.app/push",
  barkIconUrl: DEFAULT_ICON_URL,
  group: "Codex",
  sound: "minuet",
  requestTimeoutMilliseconds: 8_000,
});
