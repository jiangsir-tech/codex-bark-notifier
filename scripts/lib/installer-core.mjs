import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT = "codex-bark-notifier";
export const SCHEMA_VERSION = 1;
export class UnsafeManifestError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "UnsafeManifestError";
    this.code = "CODEX_BARK_UNSAFE_MANIFEST";
  }
}

export class UnsafePathError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "UnsafePathError";
    this.code = "CODEX_BARK_UNSAFE_PATH";
  }
}

export const RUNTIME_CONFIG = Object.freeze({
  bark: Object.freeze({
    endpoint: "https://api.day.app/push",
    icon:
      "https://raw.githubusercontent.com/jiangsir-tech/codex-bark-icon/c188b28641901dbc8b3497bf9d8a8222243ef811/codex-bark-icon.png",
    group: "Codex",
    sound: "minuet",
    requestTimeoutMilliseconds: 8_000,
  }),
});

const textDecoder = new TextDecoder();

export function assertSupportedRuntime({
  nodeVersion = process.versions.node,
  platform = process.platform,
} = {}) {
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or newer is required (found ${nodeVersion}).`);
  }
  if (platform !== "darwin") {
    throw new Error("Version 0.1 supports macOS only.");
  }
}

export function parseArguments(argv, mode) {
  const result = {
    dryRun: false,
    keyFile: "",
    purge: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      result.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--purge" && mode === "uninstall") {
      result.purge = true;
    } else if (argument === "--key-file" && mode === "install") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--key-file requires a file path.");
      }
      result.keyFile = resolve(value);
      index += 1;
    } else if (argument === "--key" || argument.startsWith("--key=")) {
      throw new Error(
        "Passing a Bark key on the command line is forbidden; use --key-file or hidden interactive input.",
      );
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return result;
}

export function resolveCodexHome(environment = process.env) {
  const configured = String(environment.CODEX_HOME ?? "").trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}

export function installationPaths({
  environment = process.env,
  packageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  ),
} = {}) {
  const codexHome = resolveCodexHome(environment);
  const installRoot = join(codexHome, "notifications", "codex-bark");
  return {
    packageRoot,
    sourceEntry: join(packageRoot, "src", "bark-notify.mjs"),
    sourceLib: join(packageRoot, "src", "lib"),
    codexHome,
    installRoot,
    entry: join(installRoot, "bark-notify.mjs"),
    library: join(installRoot, "lib"),
    runtimeConfig: join(installRoot, "config.json"),
    key: join(installRoot, "bark-device-key"),
    dispatcher: join(installRoot, "dispatcher.mjs"),
    previousNotify: join(installRoot, "previous-notify.json"),
    manifest: join(installRoot, "installed.json"),
    auditLog: join(installRoot, "bark-notify.log"),
    state: join(installRoot, "state"),
    jobs: join(installRoot, "jobs"),
    configToml: join(codexHome, "config.toml"),
    hooksJson: join(codexHome, "hooks.json"),
    backupRoot: join(codexHome, "backups", PRODUCT),
  };
}

export function validateDeviceKey(rawKey) {
  const key = String(rawKey ?? "").trim();
  if (!key) {
    throw new Error("The Bark Device Key is empty.");
  }
  if (/[\u0000-\u001f\u007f\s]/u.test(key)) {
    throw new Error("The Bark Device Key contains whitespace or control characters.");
  }
  if (key.length < 8 || key.length > 256) {
    throw new Error("The Bark Device Key has an unexpected length.");
  }
  return key;
}

export async function readDeviceKeyFromFile(
  path,
  { packageRoot = "" } = {},
) {
  const resolvedPath = resolve(path);

  let handle;
  try {
    handle = await open(
      resolvedPath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(
        "The Bark key source file must not be a symbolic link.",
      );
    }
    throw error;
  }
  try {
    const [
      handleInfo,
      pathInfo,
      canonicalSourcePath,
      canonicalPackageRoot,
    ] = await Promise.all([
      handle.stat(),
      lstat(resolvedPath),
      realpath(resolvedPath),
      packageRoot ? realpath(resolve(packageRoot)) : "",
    ]);
    const canonicalSourceInfo = await stat(canonicalSourcePath);
    if (
      !handleInfo.isFile() ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      handleInfo.nlink !== 1 ||
      handleInfo.dev !== pathInfo.dev ||
      handleInfo.ino !== pathInfo.ino ||
      handleInfo.dev !== canonicalSourceInfo.dev ||
      handleInfo.ino !== canonicalSourceInfo.ino
    ) {
      throw new Error(
        "The Bark key source must be one regular, non-linked file.",
      );
    }
    if (canonicalPackageRoot) {
      const relativePath = relative(
        canonicalPackageRoot,
        canonicalSourcePath,
      );
      if (
        relativePath === "" ||
        (
          !relativePath.startsWith(`..${sep}`) &&
          relativePath !== ".." &&
          !isAbsolute(relativePath)
        )
      ) {
        throw new Error(
          "The Bark key source file must be outside the project repository.",
        );
      }
    }
    if (
      typeof process.getuid === "function" &&
      handleInfo.uid !== process.getuid()
    ) {
      throw new Error(
        "The Bark key source file must be owned by the current user.",
      );
    }
    if ((handleInfo.mode & 0o077) !== 0) {
      throw new Error(
        "The Bark key source file must not be accessible by group or other users.",
      );
    }
    return validateDeviceKey(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export async function promptHiddenDeviceKey({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "Interactive key entry requires a TTY; use --key-file with a private file.",
    );
  }
  output.write("Bark Device Key (input hidden): ");
  input.setRawMode(true);
  input.resume();
  let key = "";
  try {
    for await (const chunk of input) {
      const value = textDecoder.decode(chunk);
      if (value.includes("\u0003")) {
        throw Object.assign(new Error("Cancelled."), { code: "EINTR" });
      }
      if (value.includes("\r") || value.includes("\n")) {
        break;
      }
      for (const character of value) {
        if (character === "\u007f" || character === "\b") {
          key = Array.from(key).slice(0, -1).join("");
        } else if (character >= " ") {
          key += character;
        }
      }
    }
  } finally {
    input.setRawMode(false);
    input.pause();
    output.write("\n");
  }
  return validateDeviceKey(key);
}

function linesWithOffsets(content) {
  const result = [];
  let offset = 0;
  for (const line of content.match(/.*(?:\n|$)/gu) ?? []) {
    if (!line) {
      continue;
    }
    result.push({ line, start: offset, end: offset + line.length });
    offset += line.length;
  }
  return result;
}

function stripTomlComment(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quote = "";
      }
    } else if (quote === "'") {
      if (character === "'") {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function tableHeader(line) {
  const clean = stripTomlComment(line).trim();
  const arrayMatch = clean.match(/^\[\[([^\[\]]+)\]\]$/u);
  if (arrayMatch) {
    return `[[${arrayMatch[1].trim()}]]`;
  }
  const match = clean.match(/^\[([^\[\]]+)\]$/u);
  return match ? match[1].trim() : null;
}

function assignmentKey(line) {
  const clean = stripTomlComment(line);
  const match = clean.match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
  return match?.[1] ?? "";
}

function arrayEndOffset(content, start) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let comment = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
      }
      continue;
    }
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quote = "";
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = "";
      }
      continue;
    }
    if (character === "#") {
      comment = true;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  throw new Error("The top-level notify array is not terminated safely.");
}

function skipTomlSpaceAndComments(source, cursor) {
  let index = cursor;
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1;
    } else if (source[index] === "#") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
    } else {
      break;
    }
  }
  return index;
}

function parseBasicTomlString(source, cursor) {
  let index = cursor + 1;
  let result = "";
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      return { value: result, next: index + 1 };
    }
    if (character !== "\\") {
      if (character === "\n" || character === "\r") {
        throw new Error("Multiline TOML strings are not supported in notify.");
      }
      result += character;
      index += 1;
      continue;
    }
    const escape = source[index + 1];
    const replacements = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (Object.hasOwn(replacements, escape)) {
      result += replacements[escape];
      index += 2;
      continue;
    }
    if (escape === "u" || escape === "U") {
      const length = escape === "u" ? 4 : 8;
      const code = source.slice(index + 2, index + 2 + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`, "u").test(code)) {
        throw new Error("Invalid Unicode escape in notify.");
      }
      result += String.fromCodePoint(Number.parseInt(code, 16));
      index += 2 + length;
      continue;
    }
    if (escape === "\n" || escape === "\r") {
      index += escape === "\r" && source[index + 2] === "\n" ? 3 : 2;
      while (index < source.length && /\s/u.test(source[index])) {
        index += 1;
      }
      continue;
    }
    throw new Error(`Unsupported TOML escape in notify: \\${escape}`);
  }
  throw new Error("Unterminated TOML string in notify.");
}

function parseLiteralTomlString(source, cursor) {
  const end = source.indexOf("'", cursor + 1);
  if (end < 0 || /[\r\n]/u.test(source.slice(cursor + 1, end))) {
    throw new Error("Invalid literal TOML string in notify.");
  }
  return { value: source.slice(cursor + 1, end), next: end + 1 };
}

export function parseTomlStringArray(source) {
  let cursor = skipTomlSpaceAndComments(source, 0);
  if (source[cursor] !== "[") {
    throw new Error("Top-level notify must be a TOML array of strings.");
  }
  cursor += 1;
  const values = [];
  let needsValue = true;
  while (cursor < source.length) {
    cursor = skipTomlSpaceAndComments(source, cursor);
    if (source[cursor] === "]") {
      return values;
    }
    if (!needsValue) {
      if (source[cursor] !== ",") {
        throw new Error("notify contains an unsafe or unsupported TOML value.");
      }
      cursor += 1;
      cursor = skipTomlSpaceAndComments(source, cursor);
      if (source[cursor] === "]") {
        return values;
      }
    }
    const parsed =
      source[cursor] === '"'
        ? parseBasicTomlString(source, cursor)
        : source[cursor] === "'"
          ? parseLiteralTomlString(source, cursor)
          : null;
    if (!parsed) {
      throw new Error("notify must contain strings only.");
    }
    values.push(parsed.value);
    cursor = parsed.next;
    needsValue = false;
  }
  throw new Error("Unterminated notify array.");
}

export function inspectTopLevelNotify(content) {
  const lines = linesWithOffsets(content);
  let section = "";
  let found = null;
  for (const row of lines) {
    const header = tableHeader(row.line);
    if (header !== null) {
      section = header;
      continue;
    }
    if (
      !section &&
      /^\s*(?:(?:["']notify["'])\s*=|(?:["']?notify["']?)\s*\.)/u.test(
        stripTomlComment(row.line),
      )
    ) {
      throw new Error(
        "A quoted or dotted top-level notify key is unsafe to edit.",
      );
    }
    if (section || assignmentKey(row.line) !== "notify") {
      continue;
    }
    if (found) {
      throw new Error("Multiple top-level notify assignments are unsafe to edit.");
    }
    const equals = content.indexOf("=", row.start);
    const arrayStart = skipTomlSpaceAndComments(content, equals + 1);
    const valueEnd = arrayEndOffset(content, arrayStart);
    const lineEnd = content.indexOf("\n", valueEnd);
    const end = lineEnd < 0 ? content.length : lineEnd + 1;
    const trailing = stripTomlComment(content.slice(valueEnd, end)).trim();
    if (trailing) {
      throw new Error("Unexpected content follows the top-level notify array.");
    }
    const assignmentStart =
      row.start === 0 && content.startsWith("\uFEFF") ? 1 : row.start;
    found = {
      exists: true,
      value: parseTomlStringArray(content.slice(arrayStart, valueEnd)),
      start: assignmentStart,
      end,
      raw: content.slice(assignmentStart, end),
    };
  }
  return found ?? {
    exists: false,
    value: null,
    start: -1,
    end: -1,
    raw: "",
  };
}

export function formatNotifyAssignment(command) {
  if (!Array.isArray(command) || !command.length) {
    throw new Error("notify command must be a non-empty string array.");
  }
  return `notify = ${JSON.stringify(command)}\n`;
}

export function replaceTopLevelNotify(content, command) {
  const current = inspectTopLevelNotify(content);
  const replacement = formatNotifyAssignment(command);
  if (!current.exists) {
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = bom ? content.slice(1) : content;
    return `${bom}${replacement}${body && !body.startsWith("\n") ? "\n" : ""}${body}`;
  }
  return `${content.slice(0, current.start)}${replacement}${content.slice(current.end)}`;
}

export function replaceTopLevelNotifyRaw(content, rawAssignment) {
  const current = inspectTopLevelNotify(content);
  if (!current.exists) {
    throw new Error("The managed top-level notify assignment is missing.");
  }
  if (!rawAssignment || assignmentKey(rawAssignment) !== "notify") {
    throw new Error("The saved previous notify assignment is invalid.");
  }
  inspectTopLevelNotify(rawAssignment);
  const normalized = rawAssignment.endsWith("\n")
    ? rawAssignment
    : `${rawAssignment}\n`;
  return (
    content.slice(0, current.start) +
    normalized +
    content.slice(current.end)
  );
}

export function removeTopLevelNotify(
  content,
  { removeFollowingBlankLine = false } = {},
) {
  const current = inspectTopLevelNotify(content);
  if (!current.exists) {
    return content;
  }
  const end =
    removeFollowingBlankLine && content[current.end] === "\n"
      ? current.end + 1
      : current.end;
  return `${content.slice(0, current.start)}${content.slice(end)}`;
}

function inspectFeatures(content) {
  const lines = linesWithOffsets(content);
  const sections = [];
  let currentSection = "";
  for (const row of lines) {
    const header = tableHeader(row.line);
    if (header !== null) {
      currentSection = header;
    } else if (
      !currentSection &&
      /^\s*(?:["']?features["']?)\s*(?:\.|=)/u.test(
        stripTomlComment(row.line),
      )
    ) {
      throw new Error(
        "A dotted or inline top-level features definition is unsafe to edit.",
      );
    }
    if (header === '"features"' || header === "'features'") {
      throw new Error("A quoted [features] table is unsafe to edit.");
    }
    if (header === "features") {
      sections.push({ headerStart: row.start, bodyStart: row.end, end: content.length });
    } else if (
      header !== null &&
      sections.length &&
      sections.at(-1).end === content.length
    ) {
      sections.at(-1).end = row.start;
    }
  }
  if (sections.length > 1) {
    throw new Error("Multiple [features] tables are unsafe to edit.");
  }
  if (!sections.length) {
    return {
      sectionExisted: false,
      keyExisted: false,
      value: null,
      assignment: null,
    };
  }
  const section = sections[0];
  const matches = [];
  for (const row of lines) {
    if (row.start < section.bodyStart || row.start >= section.end) {
      continue;
    }
    if (
      /^\s*(?:["']hooks["']|hooks\s*\.)/u.test(
        stripTomlComment(row.line),
      )
    ) {
      throw new Error("A quoted or dotted [features].hooks key is unsafe to edit.");
    }
    if (assignmentKey(row.line) === "hooks") {
      const clean = stripTomlComment(row.line);
      const match = clean.match(/^\s*hooks\s*=\s*(true|false)\s*$/u);
      if (!match) {
        throw new Error("[features].hooks must be a literal boolean.");
      }
      matches.push({
        start: row.start,
        end: row.end,
        value: match[1] === "true",
        indentation: row.line.match(/^\s*/u)?.[0] ?? "",
        valueStart: row.start + clean.lastIndexOf(match[1]),
        valueEnd: row.start + clean.lastIndexOf(match[1]) + match[1].length,
      });
    }
  }
  if (matches.length > 1) {
    throw new Error("Multiple [features].hooks assignments are unsafe to edit.");
  }
  return {
    sectionExisted: true,
    keyExisted: Boolean(matches.length),
    value: matches[0]?.value ?? null,
    assignment: matches[0] ?? null,
    section,
  };
}

export function enableHooksFeature(content) {
  const current = inspectFeatures(content);
  const before = {
    sectionExisted: current.sectionExisted,
    keyExisted: current.keyExisted,
    value: current.value,
    separatorAdded: "",
  };
  if (current.keyExisted) {
    if (current.value) {
      return { content, before };
    }
    return {
      content:
        content.slice(0, current.assignment.valueStart) +
        "true" +
        content.slice(current.assignment.valueEnd),
      before,
    };
  }
  if (current.sectionExisted) {
    const insertion = current.section.end;
    const prefix =
      insertion > 0 && content[insertion - 1] !== "\n" ? "\n" : "";
    return {
      content:
        content.slice(0, insertion) +
        `${prefix}hooks = true\n` +
        content.slice(insertion),
      before,
    };
  }
  const separator = content && !content.endsWith("\n\n")
    ? content.endsWith("\n")
      ? "\n"
      : "\n\n"
    : "";
  return {
    content: `${content}${separator}[features]\nhooks = true\n`,
    before: { ...before, separatorAdded: separator },
  };
}

export function restoreHooksFeature(content, before) {
  const current = inspectFeatures(content);
  if (before.keyExisted && before.value === true) {
    return content;
  }
  if (!current.keyExisted || current.value !== true) {
    throw new Error(
      "The managed [features].hooks value was changed after installation.",
    );
  }
  if (before.keyExisted && before.value === false) {
    return (
      content.slice(0, current.assignment.valueStart) +
      "false" +
      content.slice(current.assignment.valueEnd)
    );
  }
  let updated =
    content.slice(0, current.assignment.start) +
    content.slice(current.assignment.end);
  if (!before.sectionExisted) {
    const afterRemoval = inspectFeatures(updated);
    if (afterRemoval.sectionExisted) {
      const body = updated
        .slice(afterRemoval.section.bodyStart, afterRemoval.section.end)
        .split(/\r?\n/u)
        .map(stripTomlComment)
        .join("")
        .trim();
      if (!body) {
        let end = afterRemoval.section.end;
        while (end < updated.length && updated[end] === "\n") {
          end += 1;
        }
        let start = afterRemoval.section.headerStart;
        const separator = String(before.separatorAdded ?? "");
        if (
          separator &&
          start >= separator.length &&
          updated.slice(start - separator.length, start) === separator
        ) {
          start -= separator.length;
        }
        updated =
          updated.slice(0, start) + updated.slice(end);
      }
    }
  }
  return updated;
}

export function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const PREVIOUS_NOTIFY_FLAG = "--previous-notify";
const MAX_NOTIFY_CHAIN_DEPTH = 8;

function notifyCommandReferencesPath(command, targetPaths) {
  return command.some(
    (argument) =>
      targetPaths.has(argument) ||
      (isAbsolute(argument) && targetPaths.has(resolve(argument))),
  );
}

function inspectPreviousNotifyWrapper(command) {
  if (!safeStringArray(command)) {
    return null;
  }
  const flagIndexes = command
    .map((argument, index) =>
      argument === PREVIOUS_NOTIFY_FLAG ? index : -1,
    )
    .filter((index) => index >= 0);
  if (
    flagIndexes.length !== 1 ||
    flagIndexes[0] < 1 ||
    flagIndexes[0] + 1 >= command.length
  ) {
    return null;
  }

  const flagIndex = flagIndexes[0];
  let previous;
  try {
    previous = JSON.parse(command[flagIndex + 1]);
  } catch {
    return null;
  }
  if (!safeStringArray(previous)) {
    return null;
  }

  const base = [
    ...command.slice(0, flagIndex),
    ...command.slice(flagIndex + 2),
  ];
  return safeStringArray(base)
    ? { base, flagIndex, previous }
    : null;
}

function rewriteManagedNotifyAtDepth(
  command,
  managedNotify,
  replacementNotify,
  forbiddenPaths,
  depth,
  visited,
) {
  if (arraysEqual(command, managedNotify)) {
    return {
      matched: true,
      command: replacementNotify ? [...replacementNotify] : null,
    };
  }
  if (notifyCommandReferencesPath(command, forbiddenPaths)) {
    return {
      matched: false,
      command: [...command],
      unsafe: true,
      reason: "managed-runtime-reference",
    };
  }
  if (depth >= MAX_NOTIFY_CHAIN_DEPTH) {
    return {
      matched: false,
      command: [...command],
      unsafe: command.includes(PREVIOUS_NOTIFY_FLAG),
      reason: command.includes(PREVIOUS_NOTIFY_FLAG)
        ? "notify-chain-too-deep"
        : undefined,
    };
  }

  const fingerprint = JSON.stringify(command);
  if (visited.has(fingerprint)) {
    return {
      matched: false,
      command: [...command],
      unsafe: true,
      reason: "notify-chain-cycle",
    };
  }
  visited.add(fingerprint);

  const wrapper = inspectPreviousNotifyWrapper(command);
  if (!wrapper) {
    return command.includes(PREVIOUS_NOTIFY_FLAG)
      ? {
          matched: false,
          command: [...command],
          unsafe: true,
          reason: "malformed-previous-notify",
        }
      : { matched: false, command: [...command] };
  }
  const nested = rewriteManagedNotifyAtDepth(
    wrapper.previous,
    managedNotify,
    replacementNotify,
    forbiddenPaths,
    depth + 1,
    visited,
  );
  if (nested.unsafe) {
    return {
      matched: false,
      command: [...command],
      unsafe: true,
      reason: nested.reason,
    };
  }
  if (!nested.matched) {
    return { matched: false, command: [...command] };
  }

  if (
    nested.command &&
    arraysEqual(wrapper.previous, nested.command)
  ) {
    return { matched: true, command: [...command] };
  }
  if (!nested.command || arraysEqual(wrapper.base, nested.command)) {
    return { matched: true, command: wrapper.base };
  }
  const updated = [...command];
  updated[wrapper.flagIndex + 1] = JSON.stringify(nested.command);
  return { matched: true, command: updated };
}

export function rewriteManagedNotifyChain(
  command,
  managedNotify,
  replacementNotify,
  forbiddenPaths,
) {
  if (
    !safeStringArray(command) ||
    !safeStringArray(managedNotify) ||
    (replacementNotify !== null && !safeStringArray(replacementNotify)) ||
    !Array.isArray(forbiddenPaths) ||
    forbiddenPaths.length === 0 ||
    !forbiddenPaths.every(
      (path) => typeof path === "string" && path && isAbsolute(path),
    )
  ) {
    throw new Error("notify chain contains an invalid command.");
  }
  const normalizedForbiddenPaths = new Set(
    forbiddenPaths.flatMap((path) => [path, resolve(path)]),
  );
  if (
    !notifyCommandReferencesPath(
      managedNotify,
      normalizedForbiddenPaths,
    )
  ) {
    throw new Error("notify chain contains an invalid managed command.");
  }
  return rewriteManagedNotifyAtDepth(
    command,
    managedNotify,
    replacementNotify,
    normalizedForbiddenPaths,
    0,
    new Set(),
  );
}

export function inspectNotifyChainRisk(command, targetPaths) {
  if (
    !safeStringArray(command) ||
    !Array.isArray(targetPaths) ||
    targetPaths.length === 0 ||
    !targetPaths.every(
      (path) => typeof path === "string" && path && isAbsolute(path),
    )
  ) {
    return "invalid-notify-chain";
  }
  const targets = new Set(
    targetPaths.flatMap((path) => [path, resolve(path)]),
  );
  const visited = new Set();
  let current = command;
  for (let depth = 0; ; depth += 1) {
    if (notifyCommandReferencesPath(current, targets)) {
      return "managed-runtime-reference";
    }
    const fingerprint = JSON.stringify(current);
    if (visited.has(fingerprint)) {
      return "notify-chain-cycle";
    }
    visited.add(fingerprint);
    if (!current.includes(PREVIOUS_NOTIFY_FLAG)) {
      return null;
    }
    const wrapper = inspectPreviousNotifyWrapper(current);
    if (!wrapper) {
      return "malformed-previous-notify";
    }
    if (depth >= MAX_NOTIFY_CHAIN_DEPTH) {
      return "notify-chain-too-deep";
    }
    current = wrapper.previous;
  }
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function permissionHook(nodePath, entryPath) {
  return {
    hooks: [
      {
        type: "command",
        command: `${shellQuote(nodePath)} ${shellQuote(entryPath)} --permission`,
        timeout: 10,
        statusMessage: "Sending Bark approval notification",
      },
    ],
  };
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hookUsesEntry(entry, entryPath) {
  return (
    Array.isArray(entry?.hooks) &&
    entry.hooks.some(
      (hook) =>
        hook?.type === "command" &&
        typeof hook?.command === "string" &&
        hook.command.includes(entryPath) &&
        hook.command.includes("--permission"),
    )
  );
}

function hookEntryPath(managedEntry) {
  const command = managedEntry?.hooks?.[0]?.command ?? "";
  const match = command.match(
    /^'(?:[^']|'\\'')*'\s+'((?:[^']|'\\'')*)'\s+--permission$/u,
  );
  return match ? match[1].replaceAll("'\\''", "'") : "";
}

export function mergePermissionHook(content, managedEntry) {
  const fileExisted = Boolean(content.trim());
  let document = {};
  if (fileExisted) {
    try {
      document = JSON.parse(content);
    } catch {
      throw new Error("hooks.json is not valid JSON; refusing to overwrite it.");
    }
  }
  if (!document || Array.isArray(document) || typeof document !== "object") {
    throw new Error("hooks.json root must be an object.");
  }
  if (document.hooks !== undefined && (
    !document.hooks ||
    Array.isArray(document.hooks) ||
    typeof document.hooks !== "object"
  )) {
    throw new Error("hooks.json .hooks must be an object.");
  }
  document.hooks ??= {};
  const permissionArrayExisted = Object.hasOwn(
    document.hooks,
    "PermissionRequest",
  );
  const entries = document.hooks.PermissionRequest ?? [];
  if (!Array.isArray(entries)) {
    throw new Error("hooks.json PermissionRequest must be an array.");
  }
  const entryPath = hookEntryPath(managedEntry);
  if (entryPath && entries.some((entry) => hookUsesEntry(entry, entryPath))) {
    const exact = entries.some((entry) => deepEqual(entry, managedEntry));
    if (!exact) {
      throw new Error("An altered Codex Bark PermissionRequest hook already exists.");
    }
  }
  if (!entries.some((entry) => deepEqual(entry, managedEntry))) {
    document.hooks.PermissionRequest = [...entries, managedEntry];
  }
  return {
    content: `${JSON.stringify(document, null, 2)}\n`,
    before: { fileExisted, permissionArrayExisted },
  };
}

export function removePermissionHook(content, managedEntry, before = {}) {
  let document;
  try {
    document = JSON.parse(content || "{}");
  } catch {
    throw new Error("hooks.json is no longer valid JSON.");
  }
  const entries = document?.hooks?.PermissionRequest;
  if (entries === undefined) {
    return content;
  }
  if (!Array.isArray(entries)) {
    throw new Error("hooks.json PermissionRequest was changed after installation.");
  }
  const exactIndexes = entries
    .map((entry, index) => (deepEqual(entry, managedEntry) ? index : -1))
    .filter((index) => index >= 0);
  const command = managedEntry?.hooks?.[0]?.command ?? "";
  const entryPathMatch = command.match(/'([^']*bark-notify\.mjs)'/u)?.[1] ?? "";
  if (!exactIndexes.length) {
    if (entryPathMatch && entries.some((entry) => hookUsesEntry(entry, entryPathMatch))) {
      throw new Error("The managed PermissionRequest hook was edited after installation.");
    }
    return content;
  }
  if (exactIndexes.length > 1) {
    throw new Error("The managed PermissionRequest hook was duplicated.");
  }
  entries.splice(exactIndexes[0], 1);
  if (!entries.length && !before.permissionArrayExisted) {
    delete document.hooks.PermissionRequest;
  }
  if (
    !Object.keys(document.hooks ?? {}).length &&
    !before.fileExisted
  ) {
    delete document.hooks;
  }
  if (!Object.keys(document).length && !before.fileExisted) {
    return "";
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function dispatcherSource({ timeoutMilliseconds = 15_000 } = {}) {
  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new Error("Dispatcher timeout must be between 1 and 60000 ms.");
  }
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const payload = process.argv[2] ?? "";
const previous = JSON.parse(await readFile(join(root, "previous-notify.json"), "utf8"));
const bark = [process.execPath, join(root, "bark-notify.mjs")];

function invoke(command) {
  return new Promise((resolve) => {
    if (!Array.isArray(command) || !command.length) {
      resolve({ ok: false, reason: "empty" });
      return;
    }
    const child = spawn(command[0], [...command.slice(1), payload], {
      stdio: "ignore",
      windowsHide: true,
    });
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, reason: "timeout" });
    }, ${timeoutMilliseconds});
    child.unref();
    child.once("error", () => finish({ ok: false, reason: "spawn" }));
    child.once("exit", (code) => finish({ ok: code === 0, reason: "exit" }));
  });
}

const results = await Promise.allSettled([invoke(previous), invoke(bark)]);
if (results.every((result) => result.status === "rejected" || !result.value?.ok)) {
  process.exitCode = 1;
}
`;
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function pathMetadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function canonicalPathThroughExistingAncestor(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function assertSafePrivateRoot(paths, kind) {
  const definitions = {
    install: {
      actual: paths.installRoot,
      expected: join(
        resolve(paths.codexHome),
        "notifications",
        "codex-bark",
      ),
      canonicalSuffix: ["notifications", "codex-bark"],
    },
    backup: {
      actual: paths.backupRoot,
      expected: join(
        resolve(paths.codexHome),
        "backups",
        PRODUCT,
      ),
      canonicalSuffix: ["backups", PRODUCT],
    },
  };
  const definition = definitions[kind];
  if (!definition) {
    throw new TypeError(`Unknown private root kind: ${kind}`);
  }
  if (resolve(definition.actual) !== definition.expected) {
    throw new UnsafePathError(
      `Refusing ${kind} operation because its fixed private path is unexpected.`,
    );
  }
  await assertNotSymlink(definition.actual, {
    requireDirectory: true,
  });
  const [canonicalCodexHome, canonicalActual] = await Promise.all([
    canonicalPathThroughExistingAncestor(paths.codexHome),
    canonicalPathThroughExistingAncestor(definition.actual),
  ]);
  if (
    canonicalActual !==
    join(canonicalCodexHome, ...definition.canonicalSuffix)
  ) {
    throw new UnsafePathError(
      `Refusing ${kind} operation because its canonical private path is unexpected.`,
    );
  }
}

export async function assertSafePrivateRoots(paths) {
  await assertSafePrivateRoot(paths, "install");
  await assertSafePrivateRoot(paths, "backup");
}

export async function assertNotSymlink(
  path,
  { allowMissing = true, requireFile = false, requireDirectory = false } = {},
) {
  const metadata = await pathMetadata(path);
  if (!metadata) {
    if (allowMissing) {
      return null;
    }
    throw new UnsafePathError(`Required path is missing: ${path}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new UnsafePathError(
      `Refusing to follow a symbolic link: ${path}`,
    );
  }
  if (requireFile && !metadata.isFile()) {
    throw new UnsafePathError(`Expected a regular file: ${path}`);
  }
  if (requireDirectory && !metadata.isDirectory()) {
    throw new UnsafePathError(`Expected a directory: ${path}`);
  }
  return metadata;
}

export async function assertSafeRuntimeTargets(paths) {
  await assertSafePrivateRoots(paths);
  const rootMetadata = await assertNotSymlink(paths.installRoot);
  if (rootMetadata && !rootMetadata.isDirectory()) {
    throw new Error(`Install root is not a directory: ${paths.installRoot}`);
  }
  for (const path of [
    paths.entry,
    paths.runtimeConfig,
    paths.key,
    paths.dispatcher,
    paths.previousNotify,
    paths.manifest,
  ]) {
    await assertNotSymlink(path, { requireFile: true });
  }
  const libraryMetadata = await assertNotSymlink(paths.library);
  if (libraryMetadata) {
    if (!libraryMetadata.isDirectory()) {
      throw new Error(`Runtime lib path is not a directory: ${paths.library}`);
    }
    for (const entry of await readdir(paths.library, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Refusing a symbolic link in runtime lib: ${join(entry.parentPath, entry.name)}`,
        );
      }
    }
  }
}

export function parseJsonObject(content, label = "JSON") {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

export async function inspectRuntimeConfig(paths) {
  const metadata = await assertNotSymlink(paths.runtimeConfig, {
    requireFile: true,
  });
  if (!metadata) {
    return { exists: false, value: null, mode: null };
  }
  const value = parseJsonObject(
    await readFile(paths.runtimeConfig, "utf8"),
    "config.json",
  );
  return {
    exists: true,
    value,
    mode: metadata.mode & 0o777,
  };
}

export async function readTextIfPresent(path, fallback = "") {
  return (await pathExists(path)) ? readFile(path, "utf8") : fallback;
}

export async function atomicWrite(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/gu, "");
}

export async function createBackups(paths, files, stamp = timestamp()) {
  const backupRootMetadata = await assertNotSymlink(paths.backupRoot);
  if (backupRootMetadata && !backupRootMetadata.isDirectory()) {
    throw new Error(`Backup root is not a directory: ${paths.backupRoot}`);
  }
  const directory = join(paths.backupRoot, stamp);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const records = [];
  for (const file of files) {
    const existed = await pathExists(file);
    const destination = join(directory, basename(file));
    if (existed) {
      await cp(file, destination);
      await chmod(destination, 0o600);
    }
    records.push({ path: file, existed, backup: existed ? destination : "" });
  }
  return { directory, files: records };
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(path) {
  await assertNotSymlink(path, { allowMissing: false, requireFile: true });
  return sha256(await readFile(path));
}

async function copySourceRuntime(paths, destination) {
  if (!(await pathExists(paths.sourceEntry)) || !(await pathExists(paths.sourceLib))) {
    throw new Error("src/bark-notify.mjs and src/lib must exist before installation.");
  }
  await assertNotSymlink(paths.sourceEntry, {
    allowMissing: false,
    requireFile: true,
  });
  await assertNotSymlink(paths.sourceLib, {
    allowMissing: false,
    requireDirectory: true,
  });
  const entryPath = join(destination, "bark-notify.mjs");
  const libraryPath = join(destination, "lib");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  await cp(paths.sourceEntry, entryPath, { force: true });
  await chmod(entryPath, 0o700);
  await cp(paths.sourceLib, libraryPath, { recursive: true, force: true });
  for (const entry of await readdir(libraryPath, { recursive: true })) {
    const target = join(libraryPath, entry);
    const info = await stat(target);
    await chmod(target, info.isDirectory() ? 0o700 : 0o600);
  }
}

export async function prepareRuntimeStage(
  paths,
  { notifyMode, previousNotify, nodePath = process.execPath } = {},
) {
  await mkdir(dirname(paths.installRoot), { recursive: true, mode: 0o700 });
  const stageRoot = await mkdtemp(`${paths.installRoot}.stage-`);
  await chmod(stageRoot, 0o700);
  try {
    await copySourceRuntime(paths, stageRoot);
    if (notifyMode === "dispatcher") {
      await atomicWrite(
        join(stageRoot, "dispatcher.mjs"),
        dispatcherSource(),
        0o700,
      );
      if (!safeStringArray(previousNotify)) {
        throw new Error("The previous notifier command is invalid.");
      }
    }
    const checkFiles = [join(stageRoot, "bark-notify.mjs")];
    for (const entry of await readdir(join(stageRoot, "lib"), {
      recursive: true,
    })) {
      const target = join(stageRoot, "lib", entry);
      if ((await stat(target)).isFile() && target.endsWith(".mjs")) {
        checkFiles.push(target);
      }
    }
    if (notifyMode === "dispatcher") {
      checkFiles.push(join(stageRoot, "dispatcher.mjs"));
    }
    for (const file of checkFiles) {
      await runCommand(nodePath, ["--check", file], { stdio: "ignore" });
    }
    parseJsonObject(
      JSON.stringify(RUNTIME_CONFIG),
      "default runtime config",
    );
    return {
      root: stageRoot,
      notifyMode,
      previousNotify:
        notifyMode === "dispatcher" ? [...previousNotify] : null,
    };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function runtimeSnapshotTargets(paths) {
  return [
    paths.entry,
    paths.library,
    paths.dispatcher,
    paths.previousNotify,
    paths.manifest,
  ];
}

async function captureRuntimeTarget(target) {
  const metadata = await pathMetadata(target);
  if (!metadata) {
    return { target, existed: false, entries: [] };
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to snapshot a symbolic link: ${target}`);
  }
  if (metadata.isFile()) {
    return {
      target,
      existed: true,
      entries: [
        {
          relativePath: "",
          type: "file",
          mode: metadata.mode & 0o777,
          content: await readFile(target),
        },
      ],
    };
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Unsupported runtime path type: ${target}`);
  }

  const entries = [
    {
      relativePath: "",
      type: "directory",
      mode: metadata.mode & 0o777,
    },
  ];
  async function visit(directory, relativeDirectory = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name);
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to snapshot a symbolic link: ${path}`);
      }
      if (info.isDirectory()) {
        entries.push({
          relativePath,
          type: "directory",
          mode: info.mode & 0o777,
        });
        await visit(path, relativePath);
      } else if (info.isFile()) {
        entries.push({
          relativePath,
          type: "file",
          mode: info.mode & 0o777,
          content: await readFile(path),
        });
      } else {
        throw new Error(`Unsupported runtime path type: ${path}`);
      }
    }
  }
  await visit(target);
  return { target, existed: true, entries };
}

function metadataOnlySnapshot(metadata) {
  return metadata
    ? { existed: true, mode: metadata.mode & 0o777 }
    : { existed: false, mode: null };
}

export async function createRuntimeSnapshot(paths) {
  await assertSafeRuntimeTargets(paths);
  const installRootMetadata = await pathMetadata(paths.installRoot);
  return {
    existed: Boolean(installRootMetadata),
    installRootMode: installRootMetadata
      ? installRootMetadata.mode & 0o777
      : null,
    managed: await Promise.all(
      runtimeSnapshotTargets(paths).map(captureRuntimeTarget),
    ),
    runtimeConfig: metadataOnlySnapshot(
      await pathMetadata(paths.runtimeConfig),
    ),
    key: metadataOnlySnapshot(await pathMetadata(paths.key)),
  };
}

async function assertLegacyRuntimeSnapshotCandidate(paths, candidate) {
  await assertSafePrivateRoot(paths, "install");
  const parent = dirname(paths.installRoot);
  const prefix = `${basename(paths.installRoot)}.rollback-`;
  const candidateName = basename(candidate);
  if (
    resolve(dirname(candidate)) !== resolve(parent) ||
    !new RegExp(
      `^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[A-Za-z0-9]{6}$`,
      "u",
    ).test(candidateName)
  ) {
    throw new Error(`Unsafe legacy rollback path: ${candidate}`);
  }
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `Refusing unsafe legacy rollback entry: ${candidate}`,
    );
  }
}

export async function legacyRuntimeSnapshotPaths(paths) {
  await assertSafePrivateRoot(paths, "install");
  const parent = dirname(paths.installRoot);
  const prefix = `${basename(paths.installRoot)}.rollback-`;
  let entries = [];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (
      !entry.name.startsWith(prefix) ||
      !new RegExp(
        `^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[A-Za-z0-9]{6}$`,
        "u",
      ).test(entry.name)
    ) {
      continue;
    }
    const candidate = join(parent, entry.name);
    await assertLegacyRuntimeSnapshotCandidate(paths, candidate);
    candidates.push(candidate);
  }
  return candidates;
}

export async function removeLegacyRuntimeSnapshots(paths, candidates = null) {
  const resolvedCandidates =
    candidates ?? (await legacyRuntimeSnapshotPaths(paths));
  const failures = [];
  for (const candidate of resolvedCandidates) {
    try {
      await assertLegacyRuntimeSnapshotCandidate(paths, candidate);
      await rm(candidate, { recursive: true, force: true });
    } catch (error) {
      failures.push(
        new Error(`Could not remove legacy rollback ${candidate}: ${error.message}`, {
          cause: error,
        }),
      );
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `${failures.length} legacy rollback cleanup operation(s) failed.`,
    );
  }
  return resolvedCandidates.length;
}

export async function applyRuntimeStage(paths, stage) {
  await assertSafeRuntimeTargets(paths);
  await mkdir(paths.installRoot, { recursive: true, mode: 0o700 });
  await chmod(paths.installRoot, 0o700);
  await rm(paths.entry, { force: true });
  await rm(paths.library, { recursive: true, force: true });
  await rm(paths.dispatcher, { force: true });
  await rm(paths.previousNotify, { force: true });
  await cp(join(stage.root, "bark-notify.mjs"), paths.entry, { force: true });
  await chmod(paths.entry, 0o700);
  await cp(join(stage.root, "lib"), paths.library, {
    recursive: true,
    force: true,
  });
  if (stage.notifyMode === "dispatcher") {
    await cp(join(stage.root, "dispatcher.mjs"), paths.dispatcher, {
      force: true,
    });
    await chmod(paths.dispatcher, 0o700);
    if (!safeStringArray(stage.previousNotify)) {
      throw new Error("The staged previous notifier command is invalid.");
    }
    await atomicWrite(
      paths.previousNotify,
      `${JSON.stringify(stage.previousNotify, null, 2)}\n`,
      0o600,
    );
  }
}

async function restoreCapturedRuntimeTarget(captured) {
  await rm(captured.target, { recursive: true, force: true });
  if (!captured.existed) {
    return;
  }

  const directories = captured.entries
    .filter((entry) => entry.type === "directory")
    .sort(
      (left, right) =>
        left.relativePath.length - right.relativePath.length,
    );
  for (const entry of directories) {
    const destination = entry.relativePath
      ? join(captured.target, entry.relativePath)
      : captured.target;
    await mkdir(destination, { recursive: true, mode: 0o700 });
  }
  for (const entry of captured.entries.filter(
    (candidate) => candidate.type === "file",
  )) {
    const destination = entry.relativePath
      ? join(captured.target, entry.relativePath)
      : captured.target;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, entry.content, { mode: entry.mode });
    await chmod(destination, entry.mode);
  }
  for (const entry of [...directories].reverse()) {
    const destination = entry.relativePath
      ? join(captured.target, entry.relativePath)
      : captured.target;
    await chmod(destination, entry.mode);
  }
}

async function restoreMetadataOnlyFile(path, snapshot) {
  if (!snapshot.existed) {
    await rm(path, { force: true });
    return;
  }
  await assertNotSymlink(path, {
    allowMissing: false,
    requireFile: true,
  });
  await chmod(path, snapshot.mode);
}

export async function restoreRuntimeSnapshot(paths, snapshot) {
  if (!snapshot?.existed) {
    await rm(paths.installRoot, { recursive: true, force: true });
    return;
  }
  await mkdir(paths.installRoot, { recursive: true, mode: 0o700 });
  for (const captured of snapshot.managed ?? []) {
    await restoreCapturedRuntimeTarget(captured);
  }
  await restoreMetadataOnlyFile(paths.runtimeConfig, snapshot.runtimeConfig);
  await restoreMetadataOnlyFile(paths.key, snapshot.key);
  await chmod(paths.installRoot, snapshot.installRootMode);
}

export async function removeRuntimeTemporary(...temporaryItems) {
  for (const item of temporaryItems) {
    if (item?.root) {
      await rm(item.root, { recursive: true, force: true });
    }
  }
}

export async function runtimeFileHashes(paths) {
  const files = [paths.entry];
  if (await pathExists(paths.dispatcher)) {
    files.push(paths.dispatcher, paths.previousNotify);
  }
  const libraryEntries = await readdir(paths.library, { recursive: true });
  for (const entry of libraryEntries) {
    const target = join(paths.library, entry);
    if ((await stat(target)).isFile()) {
      files.push(target);
    }
  }
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await hashFile(file)])),
  );
}

export async function removeManagedRuntimeFiles(paths, manifest) {
  const preservedModified = [];
  for (const [file, expectedHash] of Object.entries(manifest.files ?? {})) {
    if (!(await pathExists(file))) {
      continue;
    }
    if ((await hashFile(file)) !== expectedHash) {
      preservedModified.push(file);
      continue;
    }
    await rm(file, { force: true });
  }
  if (await pathExists(paths.library)) {
    const directories = [paths.library];
    for (const entry of await readdir(paths.library, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        directories.push(join(entry.parentPath, entry.name));
      }
    }
    directories.sort((left, right) => right.length - left.length);
    for (const directory of directories) {
      await rmdir(directory).catch(
        (error) => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
            throw error;
          }
        },
      );
    }
  }
  return preservedModified;
}

export async function cleanupRuntimeEphemera(paths) {
  await rm(paths.state, { recursive: true, force: true });
  await rm(paths.jobs, { recursive: true, force: true });
}

export async function readManifest(paths) {
  const manifestMetadata = await assertNotSymlink(paths.manifest, {
    requireFile: true,
  });
  if (!manifestMetadata) {
    return null;
  }
  const manifestSource = await readFile(paths.manifest, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch (error) {
    throw new UnsafeManifestError(
      "installed.json is invalid; refusing an unsafe operation.",
      { cause: error },
    );
  }
  if (
    manifest?.product !== PRODUCT ||
    manifest?.schemaVersion !== SCHEMA_VERSION ||
    resolve(manifest.installRoot ?? "") !== paths.installRoot
  ) {
    throw new UnsafeManifestError(
      "installed.json does not describe this installation.",
    );
  }
  if (
    manifest?.config?.path !== paths.configToml ||
    manifest?.hooks?.path !== paths.hooksJson
  ) {
    throw new UnsafeManifestError(
      "installed.json contains unexpected configuration paths.",
    );
  }
  if (!["installed", "uninstalled"].includes(manifest.status)) {
    throw new UnsafeManifestError(
      "installed.json contains an invalid installation status.",
    );
  }
  if (!["direct", "dispatcher"].includes(manifest?.config?.notifyMode)) {
    throw new UnsafeManifestError(
      "installed.json contains an invalid notify mode.",
    );
  }
  if (!safeStringArray(manifest?.config?.managedNotify)) {
    throw new UnsafeManifestError(
      "installed.json managedNotify must be a non-empty string array.",
    );
  }
  const expectedManaged =
    manifest.config.notifyMode === "dispatcher"
      ? [manifest.nodePath, paths.dispatcher]
      : [manifest.nodePath, paths.entry];
  if (
    typeof manifest.nodePath !== "string" ||
    !manifest.nodePath ||
    !isAbsolute(manifest.nodePath) ||
    !arraysEqual(manifest.config.managedNotify, expectedManaged)
  ) {
    throw new UnsafeManifestError(
      "installed.json managedNotify does not match this runtime.",
    );
  }
  if (manifest.config.notifyMode === "dispatcher") {
    if (!safeStringArray(manifest.config.previousNotify)) {
      throw new UnsafeManifestError(
        "installed.json previousNotify must be a non-empty string array.",
      );
    }
    if (typeof manifest.config.previousNotifyAssignment !== "string") {
      throw new UnsafeManifestError(
        "installed.json previous notify source is invalid.",
      );
    }
    const previousSource = inspectTopLevelNotify(
      manifest.config.previousNotifyAssignment,
    );
    if (
      !previousSource.exists ||
      previousSource.start !== 0 ||
      previousSource.end !== manifest.config.previousNotifyAssignment.length ||
      !arraysEqual(previousSource.value, manifest.config.previousNotify)
    ) {
      throw new UnsafeManifestError(
        "installed.json previous notify source was tampered with.",
      );
    }
    if (
      inspectNotifyChainRisk(
        manifest.config.previousNotify,
        [paths.entry, paths.dispatcher],
      )
    ) {
      throw new UnsafeManifestError(
        "installed.json contains an unsafe or recursive previous notifier.",
      );
    }
  } else if (
    manifest.config.previousNotify !== null &&
    manifest.config.previousNotify !== undefined
  ) {
    throw new UnsafeManifestError(
      "A direct installation cannot contain previousNotify.",
    );
  }
  if (
    JSON.stringify(manifest?.hooks?.managedEntry) !==
    JSON.stringify(permissionHook(manifest.nodePath, paths.entry))
  ) {
    throw new UnsafeManifestError(
      "installed.json contains an unexpected managed hook.",
    );
  }
  const featureBefore = manifest?.config?.hooksFeatureBefore;
  if (
    !featureBefore ||
    typeof featureBefore.sectionExisted !== "boolean" ||
    typeof featureBefore.keyExisted !== "boolean" ||
    ![true, false, null].includes(featureBefore.value) ||
    !["", "\n", "\n\n"].includes(featureBefore.separatorAdded ?? "") ||
    typeof manifest.config.fileExisted !== "boolean"
  ) {
    throw new UnsafeManifestError(
      "installed.json contains invalid prior config state.",
    );
  }
  if (
    !["", "\n"].includes(manifest.config.notifySeparatorAdded ?? "")
  ) {
    throw new UnsafeManifestError(
      "installed.json contains invalid notify insertion state.",
    );
  }
  const hooksBefore = manifest?.hooks?.before;
  if (
    !hooksBefore ||
    typeof hooksBefore.fileExisted !== "boolean" ||
    typeof hooksBefore.permissionArrayExisted !== "boolean"
  ) {
    throw new UnsafeManifestError(
      "installed.json contains invalid prior hooks state.",
    );
  }
  if (
    !manifest.files ||
    Array.isArray(manifest.files) ||
    typeof manifest.files !== "object"
  ) {
    throw new UnsafeManifestError(
      "installed.json managed files are invalid.",
    );
  }
  for (const [file, hash] of Object.entries(manifest.files)) {
    const resolvedFile = resolve(file);
    const relativeToLibrary = relative(paths.library, resolvedFile);
    const allowed =
      resolvedFile === paths.entry ||
      (
        manifest.config.notifyMode === "dispatcher" &&
        (
          resolvedFile === paths.dispatcher ||
          resolvedFile === paths.previousNotify
        )
      ) ||
      (
        relativeToLibrary &&
        !relativeToLibrary.startsWith(`..${sep}`) &&
        relativeToLibrary !== ".." &&
        !isAbsolute(relativeToLibrary)
      );
    if (
      !allowed ||
      resolvedFile !== file ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(hash)
    ) {
      throw new UnsafeManifestError(
        "installed.json contains an unsafe managed file path.",
      );
    }
  }
  if (
    manifest.status === "installed" &&
    (
      !Object.hasOwn(manifest.files, paths.entry) ||
      (
        manifest.config.notifyMode === "dispatcher" &&
        (
          !Object.hasOwn(manifest.files, paths.dispatcher) ||
          !Object.hasOwn(manifest.files, paths.previousNotify)
        )
      )
    )
  ) {
    throw new UnsafeManifestError(
      "installed.json is missing required managed runtime files.",
    );
  }
  return manifest;
}

export function safeStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        !/[\u0000-\u001f\u007f]/u.test(item),
    )
  );
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${basename(command)} exited with status ${code}.`));
      }
    });
  });
}
