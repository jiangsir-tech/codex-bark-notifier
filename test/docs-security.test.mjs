import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants as fileConstants } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function documentation() {
  const [readme, guide, security] = await Promise.all([
    readFile(join(packageRoot, "README.md"), "utf8"),
    readFile(join(packageRoot, "docs", "INSTALL_WITH_CODEX.md"), "utf8"),
    readFile(join(packageRoot, "SECURITY.md"), "utf8"),
  ]);
  return { readme, guide, security };
}

function textPromptBlocks(source) {
  return [...source.matchAll(/```text\s*\n([\s\S]*?)\n```/gu)].map(
    (match) => match[1],
  );
}

test("convenience prompt supports URL plus Device Key without secondary leakage", async () => {
  const { readme, guide, security } = await documentation();
  const prompts = textPromptBlocks(guide);
  assert.equal(prompts.length, 2);
  const prompt = prompts[0];

  assert.match(prompt, /Mac 本地/u);
  assert.match(
    prompt,
    /https:\/\/github\.com\/jiangsir-tech\/codex-bark-notifier/u,
  );
  assert.match(prompt, /我的 Bark Device Key：\s*\n<粘贴你自己的 Device Key>/u);
  assert.match(prompt, /Device Key 会进入本次 Codex 对话/u);
  assert.match(prompt, /工具调用记录/u);
  assert.match(prompt, /最终报告中重复、截取或展示/u);

  for (const requiredBoundary of [
    /不得把它放进 shell 命令/u,
    /命令行参数/u,
    /环境变量/u,
    /仓库文件/u,
    /项目日志/u,
    /最终回复/u,
    /交互式 TTY/u,
    /Bark Device Key \(input hidden\):/u,
    /输入不得回显/u,
  ]) {
    assert.match(prompt, requiredBoundary);
  }
  assert.doesNotMatch(prompt, /--key(?:\s|=)/u);
  assert.doesNotMatch(prompt, /\bBARK_(?:KEY|TOKEN)\s*=/u);

  assert.match(prompt, /sh scripts\/install\.sh --verify/u);
  assert.match(prompt, /sh scripts\/install\.sh --dry-run/u);
  assert.match(prompt, /sh scripts\/install\.sh --send-test/u);
  assert.match(prompt, /最多运行一次/u);
  assert.match(prompt, /暂停并问我 iPhone 是否实际显示/u);
  assert.match(prompt, /不得仅凭 HTTP 或 Bark API 成功/u);

  assert.match(prompt, /PATH、ChatGPT\.app 或 Codex\.app/u);
  assert.match(prompt, /不要要求我预先单独安装 Node\.js 或 Codex CLI/u);
  assert.doesNotMatch(prompt, /command -v codex[^。\n]*停止/u);
  assert.doesNotMatch(prompt, /command -v node[^。\n]*停止/u);

  assert.match(prompt, /亲自选择 Trust/u);
  assert.match(prompt, /不得自动信任 Hook/u);
  assert.match(prompt, /不得写入或伪造信任状态/u);
  assert.match(prompt, /不得使用绕过 Hook trust 的参数/u);
  assert.match(prompt, /只能提醒，不得自动批准或拒绝/u);

  assert.match(prompt, /四种通知的当前启用状态/u);
  assert.match(prompt, /声音、图标、分组、点击链接/u);
  assert.match(readme, /复制给 Codex 安装/u);
  assert.match(readme, /会留在这次对话和可能的工具记录里/u);
  assert.match(security, /便捷自动安装/u);
  assert.match(security, /本项目无法验证、控制或删除 Codex 平台/u);
});

test("README stays focused on the four-part Codex install path", async () => {
  const { readme } = await documentation();
  const headings = [...readme.matchAll(/^## (.+)$/gmu)].map(
    (match) => match[1],
  );

  assert.deepEqual(headings, [
    "1. 这是做什么的",
    "2. iPhone 上的通知效果",
    "3. 做了哪些优化，还有哪些不足",
    "4. 复制给 Codex 安装",
  ]);
  assert.match(
    readme,
    /\[快速安装 Codex Bark Notifier\]\(#4-复制给-codex-安装\)/u,
  );
  assert.match(readme, /Codex Desktop，新建一个本地任务/u);
  assert.match(readme, /不要只告诉我怎么操作/u);
  assert.match(readme, /<粘贴你自己的 Device Key>/u);
  assert.doesNotMatch(readme, /方式 [ABC]/u);
  assert.doesNotMatch(readme, /手工安装/u);
  assert.doesNotMatch(readme, /^## (?:更新与卸载|开发与发布|常见问题)/gmu);
});

test("privacy prompt keeps Device Key in the user's hidden Terminal input", async () => {
  const { guide, security } = await documentation();
  const prompts = textPromptBlocks(guide);
  const prompt = prompts[1];

  assert.match(prompt, /不会把 Bark Device Key 发进对话/u);
  assert.match(prompt, /独立 Terminal/u);
  assert.match(prompt, /Bark Device Key \(input hidden\):/u);
  assert.match(prompt, /亲自粘贴 Key/u);
  assert.match(prompt, /不要索要、读取、搜索、哈希、保存或转述 Key/u);
  assert.match(prompt, /不得自动信任、绕过信任或自动批准/u);
  assert.doesNotMatch(prompt, /<粘贴你自己的 Device Key>/u);
  assert.doesNotMatch(prompt, /--key(?:\s|=)/u);

  assert.match(security, /隐藏输入安装/u);
  assert.match(security, /用户在独立 Terminal 的隐藏 TTY 提示中亲自输入 Key/u);
});

test("documentation preserves the Device Key and Hook security model", async () => {
  const { readme, guide, security } = await documentation();
  const all = `${readme}\n${guide}\n${security}`;

  assert.match(security, /不是 Apple ID、ChatGPT 账号密码或设备解锁凭据/u);
  assert.match(security, /可以向对应 Bark 设备发送任意通知正文和点击链接/u);
  assert.match(security, /不代表这些记录一定只保存在本机/u);
  assert.match(security, /不得把 Key 放入命令行参数、环境变量、URL/u);
  assert.match(security, /安装器不会擅自删除用户提供的源文件/u);
  assert.match(security, /安装器写入并启用 Hook 不等于 Hook 已被信任/u);
  assert.match(security, /--dangerously-bypass-hook-trust/u);
  assert.match(security, /不把用户 Hook 冒充为受管 Hook/u);
  assert.doesNotMatch(all, /BARK_(?:KEY|TOKEN)\s*=/u);
});

test("the detailed guide uses the full runtime-discovering verification command", async () => {
  const { guide } = await documentation();
  assert.match(guide, /sh scripts\/install\.sh --verify/u);
  assert.doesNotMatch(guide, /^\s*npm test\s*$/gmu);

  const releaseGuide = await readFile(
    join(packageRoot, "docs", "RELEASING.md"),
    "utf8",
  );
  assert.match(releaseGuide, /npm run test:all/u);

  await access(
    join(packageRoot, "scripts", "install.sh"),
    fileConstants.R_OK | fileConstants.X_OK,
  );
});
