import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Codex-assisted installation never asks for a Bark key in AI context", async () => {
  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  const guide = await readFile(
    join(packageRoot, "docs", "INSTALL_WITH_CODEX.md"),
    "utf8",
  );
  const documentation = `${readme}\n${guide}`;
  const promptBlocks = [
    ...guide.matchAll(/```text\s*\n([\s\S]*?)\n```/gu),
  ].map((match) => match[1]);
  assert.equal(promptBlocks.length, 1);
  const prompt = promptBlocks[0];
  const unsafePromptPatterns = [
    /--key(?:-file)?(?:\s|=)/u,
    /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN)[A-Z0-9_]*\s*=/u,
  ];
  const aiPattern = /(?:Codex|AI)/iu;
  const secretPattern =
    /(?:密钥|Device Key|Bark Key|\bKey\b|\bToken\b)/iu;
  const transferPattern =
    /(?:回复|答复|发送|发给|提供|交给|提交|粘贴|贴出|写入|保存|上传|告诉|转述|输入)/u;
  const explicitlySafeTransferPatterns = [
    /^(?:我)?(?:不会|不得|禁止|切勿|绝不(?:会)?|不要)(?:把|将).{0,20}(?:密钥|Device Key|Bark Key|\bKey\b|\bToken\b).{0,20}(?:回复|答复|发送|发给|提供|交给|提交|粘贴|贴出|写入|保存|上传|告诉|转述|输入).{0,20}(?:Codex|AI)(?:对话|消息)?$/iu,
    /^(?:我)?(?:不会|不得|禁止|切勿|绝不(?:会)?|不要)(?:向|给).{0,12}(?:Codex|AI).{0,12}(?:回复|答复|发送|发给|提供|交给|提交|粘贴|贴出|写入|保存|上传|告诉|转述|输入).{0,20}(?:密钥|Device Key|Bark Key|\bKey\b|\bToken\b)$/iu,
    /^(?:Codex|AI)\s*(?:不会|不得|禁止|切勿|绝不(?:会)?|不要)(?:(?:要求|允许|让)(?:你|我|用户))?\s*(?:回复|答复|发送|发给|提供|交给|提交|粘贴|贴出|写入|保存|上传|告诉|转述|输入).{0,20}(?:密钥|Device Key|Bark Key|\bKey\b|\bToken\b)$/iu,
    /^(?:我)?(?:不会|不得|禁止|切勿|绝不(?:会)?|不要)\s*(?:Codex|AI).{0,12}(?:回复|答复|发送|发给|提供|交给|提交|粘贴|贴出|写入|保存|上传|告诉|转述|输入).{0,20}(?:密钥|Device Key|Bark Key|\bKey\b|\bToken\b)$/iu,
    /^(?:我)?(?:不会|不得|禁止|切勿|绝不(?:会)?|不要)\s*(?:回复|答复|发送|发给|提供|交给|提交|粘贴|贴出|写入|保存|上传|告诉|转述|输入).{0,20}(?:密钥|Device Key|Bark Key|\bKey\b|\bToken\b).{0,20}(?:Codex|AI)$/iu,
    /^(?:我)?(?:不会|不得|禁止|切勿|绝不(?:会)?|不要)\s*(?:回复|答复|发送|发给|提供|交给|提交|粘贴|贴出|写入|保存|上传|告诉|转述|输入).{0,20}(?:Codex|AI).{0,20}(?:密钥|Device Key|Bark Key|\bKey\b|\bToken\b)$/iu,
  ];
  const unsafeAiSecretTransferClause = (clause) => {
    const normalized = clause.trim();
    if (
      !aiPattern.test(normalized) ||
      !secretPattern.test(normalized) ||
      !transferPattern.test(normalized)
    ) {
      return false;
    }
    return !explicitlySafeTransferPatterns.some((pattern) =>
      pattern.test(normalized)
    );
  };
  const isUnsafePrompt = (candidate) =>
    unsafePromptPatterns.some((pattern) => pattern.test(candidate)) ||
    candidate
      .split(/[，,。；;！？!?\r\n]+/u)
      .some(unsafeAiSecretTransferClause);

  for (const unsafePattern of [
    /我的 Bark Device Key 是/u,
    /<在这里填写[^>]*Device Key[^>]*>/u,
    /把我提供的 Key/u,
    /Device Key 只能发给你自己本机的 Codex/u,
  ]) {
    assert.doesNotMatch(documentation, unsafePattern);
  }

  assert.equal(isUnsafePrompt(prompt), false);
  for (const knownUnsafeVariant of [
    "请在下一条 Codex 消息中回复你的密钥。",
    "BARK_KEY=真实密钥 node scripts/install.mjs",
    "请让 Codex 把密钥写入 /tmp/private-key。",
    "不要担心，请在下一条 Codex 消息中回复你的密钥。",
    "不要担心请把 Bark Key 发给 Codex。",
    "不要犹豫将 Device Key 提供给 AI。",
  ]) {
    assert.equal(
      isUnsafePrompt(knownUnsafeVariant),
      true,
      `unsafe prompt variant was not detected: ${knownUnsafeVariant}`,
    );
  }
  for (const knownSafeVariant of [
    "不要把 Bark Key 发给 Codex。",
    "禁止将 Device Key 提供给 AI。",
    "我绝不会把 Key 交给 Codex。",
    "Codex 不得要求你输入 Device Key。",
    "AI 禁止保存密钥。",
  ]) {
    assert.equal(
      isUnsafePrompt(knownSafeVariant),
      false,
      `safe prompt variant was incorrectly rejected: ${knownSafeVariant}`,
    );
  }

  assert.match(prompt, /我不会把 Bark Device Key 发给你/u);
  assert.match(prompt, /node scripts\/install\.mjs --dry-run/u);
  assert.match(prompt, /必须暂停/u);
  assert.match(prompt, /独立的 macOS Terminal/u);
  assert.match(prompt, /不得替我启动交互安装器/u);
  assert.match(prompt, /Bark Device Key \(input hidden\)/u);
  assert.match(prompt, /只回复“安装器执行完成”/u);
  assert.match(prompt, /不得读取[^。\n]*bark-device-key/u);
  assert.match(prompt, /command -v codex/u);
  assert.match(prompt, /找不到 \/hooks[^。\n]*更新 CLI/u);
  assert.match(prompt, /CODEX_HOME/u);
  assert.match(
    prompt,
    /dry-run 和真实安装必须使用同一个 Codex Home/u,
  );
  assert.match(
    prompt,
    /env CODEX_HOME='\/实际 Codex Home' node/u,
  );
  assert.match(prompt, /npm run test:all/u);
  assert.match(
    prompt,
    /真实 Bark 测试通知[^。\n]*。发送后必须暂停[^。\n]*明确确认/u,
  );
  assert.match(prompt, /不得仅凭 HTTP 或 Bark API 返回成功/u);
});

test("installation and release docs use the full verification command", async () => {
  const documentationPaths = [
    "README.md",
    join("docs", "INSTALL_WITH_CODEX.md"),
    join("docs", "RELEASING.md"),
  ];

  for (const documentationPath of documentationPaths) {
    const documentation = await readFile(
      join(packageRoot, documentationPath),
      "utf8",
    );
    assert.match(
      documentation,
      /npm run test:all/u,
      `${documentationPath} must use the full verification command`,
    );
    assert.doesNotMatch(
      documentation,
      /^\s*npm test\s*$/gmu,
      `${documentationPath} must not use the partial test command`,
    );
  }
});
