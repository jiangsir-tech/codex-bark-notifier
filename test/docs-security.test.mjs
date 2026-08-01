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

function section(source, heading, nextHeading) {
  const start = source.indexOf(`## ${heading}`);
  assert.notEqual(start, -1);
  const end = nextHeading ? source.indexOf(`## ${nextHeading}`, start) : -1;
  return source.slice(start, end === -1 ? undefined : end);
}

test("convenience prompt supports URL plus Device Key without secondary leakage", async () => {
  const { readme, guide, security } = await documentation();
  const prompts = textPromptBlocks(guide);
  assert.equal(prompts.length, 2);
  const prompt = prompts[0];

  assert.match(prompt, /Mac 本地/u);
  assert.match(
    prompt,
    /https:\/\/github\.com\/jiangsir-tech\/codex-bark-notifier\/tree\/v0\.1\.0/u,
  );
  assert.match(prompt, /只使用 `v0\.1\.0` Tag/u);
  assert.match(prompt, /不要改用 main 分支/u);
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
  assert.match(prompt, /Bark 服务地址、图标、声音、分组、请求超时/u);
  assert.match(prompt, /需要修改源码并重新安装/u);
  assert.match(readme, /复制给 Codex 安装/u);
  assert.match(readme, /会让 Key 进入这次 Codex 对话/u);
  assert.match(security, /便捷自动安装/u);
  assert.match(security, /本项目无法验证、控制或删除 Codex 平台/u);
});

test("README stays focused on the six-part Codex workflow", async () => {
  const { readme } = await documentation();
  const headings = [...readme.matchAll(/^## (.+)$/gmu)].map(
    (match) => match[1],
  );

  assert.deepEqual(headings, [
    "1. 这是做什么的",
    "2. iPhone 上的通知效果",
    "3. 做了哪些优化，还有哪些不足",
    "4. 复制给 Codex 安装",
    "5. 复制给 Codex 更新",
    "6. 复制给 Codex 卸载",
  ]);
  assert.match(
    readme,
    /\[快速安装 Codex Bark Notifier\]\(#4-复制给-codex-安装\)/u,
  );
  assert.match(readme, /ChatGPT 桌面端里的 Codex（或 Codex 桌面端）/u);
  assert.match(readme, /不要只告诉我怎么操作/u);
  assert.match(readme, /<粘贴你自己的 Device Key>/u);
  assert.doesNotMatch(readme, /^> \[!IMPORTANT\]$/gmu);
  assert.match(readme, /> 🟣 \*\*步骤 1｜获取 Bark Device Key\*\*/u);
  assert.match(readme, /> 🟣 \*\*步骤 2｜交给 Codex 自动安装\*\*/u);
  const retentionWarning = readme.indexOf("下面的便捷方式会让 Key 进入");
  const keyPlaceholder = readme.indexOf("<粘贴你自己的 Device Key>");
  assert.notEqual(retentionWarning, -1);
  assert.notEqual(keyPlaceholder, -1);
  assert.ok(retentionWarning < keyPlaceholder);
  assert.match(readme, /独立 Terminal 隐藏输入方式/u);
  assert.match(readme, /不需要再次提供 Device Key/u);
  assert.match(readme, /sh scripts\/install\.sh --uninstall --dry-run/u);
  assert.match(readme, /sh scripts\/install\.sh --uninstall/u);
  assert.match(readme, /不要使用 --purge/u);
  assert.doesNotMatch(readme, /方式 [ABC]/u);
  assert.doesNotMatch(readme, /手工安装/u);
  assert.doesNotMatch(readme, /^## (?:更新与卸载|开发与发布|常见问题)/gmu);
});

test("README gives Codex one safe prompt for update and uninstall", async () => {
  const { readme } = await documentation();
  const update = section(
    readme,
    "5. 复制给 Codex 更新",
    "6. 复制给 Codex 卸载",
  );
  const uninstall = section(readme, "6. 复制给 Codex 卸载");
  const updatePrompts = textPromptBlocks(update);
  const uninstallPrompts = textPromptBlocks(uninstall);

  assert.equal(updatePrompts.length, 1);
  assert.equal(uninstallPrompts.length, 1);

  const updatePrompt = updatePrompts[0];
  assert.match(
    updatePrompt,
    /https:\/\/github\.com\/jiangsir-tech\/codex-bark-notifier\/tree\/v0\.1\.0/u,
  );
  assert.match(updatePrompt, /不要改用 main 分支/u);
  assert.match(updatePrompt, /新的临时目录/u);
  assert.match(updatePrompt, /如果 Key 缺失就停止/u);
  assert.match(updatePrompt, /sh scripts\/install\.sh --verify/u);
  assert.match(updatePrompt, /sh scripts\/install\.sh --dry-run/u);
  assert.match(updatePrompt, /保留我的自定义 config\.json/u);
  assert.match(updatePrompt, /sh scripts\/install\.sh --send-test/u);
  assert.match(updatePrompt, /确认 iPhone 是否实际收到/u);
  assert.match(updatePrompt, /新增、已变化或未信任/u);
  assert.match(updatePrompt, /不得自动信任/u);
  assert.match(updatePrompt, /commit SHA/u);

  const uninstallPrompt = uninstallPrompts[0];
  assert.match(
    uninstallPrompt,
    /https:\/\/github\.com\/jiangsir-tech\/codex-bark-notifier\/tree\/v0\.1\.0/u,
  );
  assert.match(uninstallPrompt, /不要改用 main 分支/u);
  assert.match(uninstallPrompt, /sh scripts\/install\.sh --uninstall --dry-run/u);
  assert.equal(
    [...uninstallPrompt.matchAll(/sh scripts\/install\.sh --uninstall(?! --dry-run)/gu)]
      .length,
    1,
  );
  assert.match(uninstallPrompt, /不要使用 --purge/u);
  assert.match(uninstallPrompt, /公开配置、日志、卸载清单和备份/u);
  assert.match(uninstallPrompt, /无法安全恢复，就停止/u);
  assert.match(uninstallPrompt, /临时 state 和 jobs 已清理/u);
  assert.match(uninstallPrompt, /本地修改过的文件/u);
  assert.match(uninstallPrompt, /只有我之后明确要求/u);
  assert.match(uninstallPrompt, /可能留下悬空 Codex 配置/u);
});

test("privacy prompt keeps Device Key in the user's hidden Terminal input", async () => {
  const { guide, security } = await documentation();
  const prompts = textPromptBlocks(guide);
  const prompt = prompts[1];

  assert.match(prompt, /不会把 Bark Device Key 发进对话/u);
  assert.match(
    prompt,
    /https:\/\/github\.com\/jiangsir-tech\/codex-bark-notifier\/tree\/v0\.1\.0/u,
  );
  assert.match(prompt, /独立 Terminal/u);
  assert.match(prompt, /Bark Device Key \(input hidden\):/u);
  assert.match(prompt, /亲自粘贴 Key/u);
  assert.match(prompt, /不要索要、读取、搜索、哈希、另存或转述 Key/u);
  assert.match(prompt, /权限为 600 的私有密钥文件/u);
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
  assert.match(security, /普通 JSON 请求/u);
  assert.match(security, /经 HTTPS 发往配置的 Bark 服务/u);
  assert.match(security, /没有实现 Bark 的内容加密模式/u);
  assert.match(security, /allowInsecureLoopback: true/u);
  assert.match(security, /只读取与目标 `turn-id` 精确匹配的最终回复/u);
  assert.match(security, /在入队时固定请求简称/u);
  assert.match(security, /取得生命周期锁/u);
  assert.match(security, /后续并发修改会被保留并报告/u);
  assert.match(
    readme,
    /Device Key 不是 Apple ID、ChatGPT 密码或设备解锁凭据/u,
  );
  assert.match(readme, /可以向这台 Bark 设备发送任意通知正文和点击链接/u);
  assert.doesNotMatch(all, /BARK_(?:KEY|TOKEN)\s*=/u);
});

test("documentation states the real platform and configuration boundaries", async () => {
  const { readme, guide } = await documentation();
  const all = `${readme}\n${guide}`;

  assert.match(all, /只支持 macOS/u);
  assert.match(all, /Node\.js 22 和 24/u);
  assert.match(readme, /独立社区项目，不是 OpenAI 官方产品/u);
  assert.match(
    readme,
    /config\.json.+Bark 服务地址、通知图标、铃声、分组和请求超时/u,
  );
  assert.match(readme, /不是公开配置项；要改变这些规则，需要修改源码/u);
  assert.match(readme, /普通 JSON 经 HTTPS/u);
  assert.match(readme, /没有实现 Bark 的内容加密模式/u);
  assert.doesNotMatch(readme, /iPhone 不会收到通知/u);
  assert.doesNotMatch(readme, /会跳转到 iPhone 上 ChatGPT 的 Codex 页面/u);
});

test("release metadata is prepared for immutable v0.1.0", async () => {
  const [changelog, releaseGuide, notice, packageSource] = await Promise.all([
    readFile(join(packageRoot, "CHANGELOG.md"), "utf8"),
    readFile(join(packageRoot, "docs", "RELEASING.md"), "utf8"),
    readFile(join(packageRoot, "NOTICE.md"), "utf8"),
    readFile(join(packageRoot, "package.json"), "utf8"),
  ]);
  const packageMetadata = JSON.parse(packageSource);

  assert.match(changelog, /## \[0\.1\.0\] - 2026-08-01/u);
  assert.doesNotMatch(changelog, /## \[0\.1\.0\] - Unreleased/u);
  assert.match(releaseGuide, /不得移动或覆盖 `v0\.1\.0` Tag/u);
  assert.match(notice, /jiangsir-tech\/codex-bark-icon/u);
  assert.match(notice, /not covered by this repository's MIT License/u);
  assert.equal(packageMetadata.version, "0.1.0");
  assert.deepEqual(packageMetadata.os, ["darwin"]);
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
