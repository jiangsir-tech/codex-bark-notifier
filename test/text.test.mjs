import assert from "node:assert/strict";
import test from "node:test";

import {
  ANSWER_SUMMARY_CHARACTER_LIMIT,
  classifyLastReply,
  completionDelayMilliseconds,
  conversationNameFromPayload,
  formatNotification,
  notificationBodyFromAssistantReply,
  normalizeTaskName,
  sanitizeNotificationText,
  shortenAssistantSummary,
  shortenConversationName,
  truncateText,
} from "../src/lib/text.mjs";

test("four notification formats are exact", () => {
  const task = "示例任务";
  const conversation = "整理今天的会议记录";
  const cases = [
    [{ icon: "✅", label: "本轮结束" }, "✅ [示例任务]本轮结束"],
    [{ icon: "🔁", label: "需要你回复" }, "🔁 [示例任务]需要你回复"],
    [{ icon: "⛔", label: "受阻或出错" }, "⛔ [示例任务]受阻或出错"],
    [{ icon: "🔐", label: "需要你批准" }, "🔐 [示例任务]需要你批准"],
  ];

  for (const [status, title] of cases) {
    assert.deepEqual(formatNotification(status, task, conversation), {
      title,
      body: "💬整理今天的会议记录",
    });
  }
});

test("reply classification prioritizes errors, then actions, then completion", () => {
  assert.deepEqual(classifyLastReply("测试仍然失败，请确认下一步？"), {
    icon: "⛔",
    label: "受阻或出错",
  });
  assert.deepEqual(classifyLastReply("请上传缺少的文件。"), {
    icon: "🔁",
    label: "需要你回复",
  });
  assert.deepEqual(classifyLastReply("你希望我继续吗？"), {
    icon: "🔁",
    label: "需要你回复",
  });
  assert.deepEqual(classifyLastReply("已完成，全部测试通过。"), {
    icon: "✅",
    label: "本轮结束",
  });
  assert.deepEqual(classifyLastReply("earlier failed to compile\n最终已经修复完成"), {
    icon: "✅",
    label: "本轮结束",
  });
  assert.deepEqual(classifyLastReply("earlier failed to compile\nstill failing"), {
    icon: "⛔",
    label: "受阻或出错",
  });
  assert.deepEqual(
    classifyLastReply(
      "本地草稿已准备好。请在安全扫描页面点击 Start scan，随后告诉我。",
    ),
    {
      icon: "🔁",
      label: "需要你回复",
    },
  );
  assert.deepEqual(classifyLastReply("系统错误已修复，不需要你确认。"), {
    icon: "✅",
    label: "本轮结束",
  });
  assert.deepEqual(classifyLastReply("未发现错误，也无需你操作。"), {
    icon: "✅",
    label: "本轮结束",
  });
  assert.deepEqual(classifyLastReply("请你先在 Hooks 页面点击信任。"), {
    icon: "🔁",
    label: "需要你回复",
  });
  assert.deepEqual(classifyLastReply("不需要你先确认，配置已经生效。"), {
    icon: "✅",
    label: "本轮结束",
  });
  assert.deepEqual(
    classifyLastReply(
      "通知摘要已优化并实时生效，75 项测试全部通过。\n\n- 修复“请在页面点击”漏判，以及“错误已修复”“无需确认”被误判的问题。",
    ),
    {
      icon: "✅",
      label: "本轮结束",
    },
  );
  assert.deepEqual(
    classifyLastReply(
      "规则现在能识别“系统错误”这类状态文本，测试全部通过。",
    ),
    {
      icon: "✅",
      label: "本轮结束",
    },
  );
  assert.deepEqual(
    classifyLastReply(
      "示例代码不应改变状态：\n```text\n请在页面点击 Start scan\n```\n规则测试通过。",
    ),
    {
      icon: "✅",
      label: "本轮结束",
    },
  );
  assert.deepEqual(
    classifyLastReply("请在页面点击“Start scan”，随后告诉我。"),
    {
      icon: "🔁",
      label: "需要你回复",
    },
  );
  assert.deepEqual(
    classifyLastReply("通知已经恢复。此前因为配置失败导致过误报。"),
    {
      icon: "✅",
      label: "本轮结束",
    },
  );
  for (const reply of [
    "测试通知已经发送。把实际结果告诉我，我们再决定正式方案。",
    "三版提示音已生成。你听完告诉我选 A、B 还是 C。",
    "使用内置铃声更稳定。把铃声的英文名称发给我，我再修改配置。",
    "需要你告诉我结果。",
    "如果测试失败，把实际结果告诉我。",
    "你测试完以后，把结果发给我。",
    "完成以后回来告诉我结果。",
  ]) {
    assert.deepEqual(classifyLastReply(reply), {
      icon: "🔁",
      label: "需要你回复",
    });
  }
  for (const reply of [
    "验证已经完成，不需要把实际结果告诉我。",
    "如果你愿意，以后可以把结果告诉我。",
    "如果需要，请告诉我。",
    "不再等待你确认，配置已经生效。",
    "有问题可以告诉我，本轮已经完成。",
    "文档示例是“把实际结果告诉我”，规则测试通过。",
    "状态文案是 `把实际结果告诉我`，规则测试通过。",
    "不需要你来确认。",
    "不需要你去操作。",
    "不用等你回复。",
    "无需你完成后告诉我。",
    "你愿意的话，把结果告诉我；不回复也可以。",
    "已经完成，你愿意的话，把结果告诉我。",
    "方便的话，把结果发给我；本轮无需回复。",
    "已经完成，方便的话，把结果发给我。",
    "你可以把结果发给我，也可以不发。",
    "你看到完成标志后，系统会告诉我结果。",
    "你无需操作，日志完成后会告诉我结果。",
    "请不要把结果告诉我。",
    "已经完成，请不要把结果告诉我。",
    "没必要把结果告诉我。",
    "「把结果告诉我」只是文案。",
    "『请点击确认』只是文案。",
    "~~~text\n把结果告诉我\n~~~\n规则测试通过。",
    "示例代码如下：\n    把结果告诉我\n规则测试通过。",
    "[把结果告诉我](https://example.com/docs) 只是文档链接。",
    "<!-- 请点击确认 -->\n通知已经完成。",
    "> 请点击只是引用。\n测试通过。",
    "> 系统错误只是引用。\n测试通过。",
  ]) {
    assert.deepEqual(classifyLastReply(reply), {
      icon: "✅",
      label: "本轮结束",
    });
  }
  assert.deepEqual(classifyLastReply("你愿意继续测试吗？"), {
    icon: "🔁",
    label: "需要你回复",
  });
  assert.deepEqual(
    classifyLastReply("请点击确认，本轮无需回复。"),
    {
      icon: "🔁",
      label: "需要你回复",
    },
  );
});

test("reply classification covers real continuation requests without optional false positives", () => {
  const replies = [
    "build 8 已运行，请重复最后一次双项验收。",
    "本地 README 已存在。改完保存后，只需告诉我“改好了”，我会统一处理。",
    "录屏权限已确认，请先做一次键盘验收。",
    "系统正在等待你的 Touch ID 授权。请现在按一下 Touch ID。完成后回复“好了”，我继续核验。",
    "这一轮只做了检查，没有修改。你确认的话，我就按这组参数直接调整并逐帧验收。",
    "当前数据已整理。下一步先把这两组信息发给我，截图即可。",
    "有一个隐私变化需要你确认。你确认允许保存后，我就可以实现。",
    "不用一次发齐，可以逐个平台发。最优先发未来30天内最早到期的那笔。",
    "两笔账单已经并入。下一张优先发京东金条的还款计划。",
  ];
  for (const reply of replies) {
    assert.deepEqual(classifyLastReply(reply), {
      icon: "🔁",
      label: "需要你回复",
    });
  }

  for (const reply of [
    "本轮已经完成。如果方便，可以以后再发截图；无需回复。",
    "这里是在解释流程：用户确认后，程序就会继续执行。",
    "建议下一步优化通知摘要，但这轮不需要你确认。",
    "如果你愿意，我可以继续优化。",
    "如果方便，再截提前结清页面也行；本轮无需回复。",
    "你可以在主微信分别做一次键盘和语音输入，随后查看结果。",
    "后面可以优化成保存两三个常用尺寸。",
    "建议之后做一次验收，本轮无需回复。",
    "下一步我会自动检查，无需你操作。",
    "系统会最优先发送未来30天的提醒。",
    "下一张截图将自动发送。",
    "请先做一次验收。后来我已代你完成，不需要你操作。",
    "请先点击确认；刚刚已经完成，不需要你操作。",
  ]) {
    assert.deepEqual(classifyLastReply(reply), {
      icon: "✅",
      label: "本轮结束",
    });
  }

  assert.deepEqual(classifyLastReply("请点击确认，本轮无需回复。"), {
    icon: "🔁",
    label: "需要你回复",
  });
});

test("reply notification body prioritizes the concrete user action", () => {
  const status = { icon: "🔁", label: "需要你回复" };
  assert.equal(
    notificationBodyFromAssistantReply(
      "“不可用”已修复，现有校准已成功建立基线。最后请做一次来源验收。完成后回复“好了”。",
      status,
      "校准微信输入区",
    ),
    "完成后回复“好了”。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "当前金融负债已经整理。下一步先把这两组信息发给我，截图即可。拿到数据后我继续分析。",
      status,
      "整理个人负债",
    ),
    "下一步先把这两组信息发给我，截图即可。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "配置已完成，不需要你确认。",
      { icon: "✅", label: "本轮结束" },
      "更新配置",
    ),
    "配置已完成，不需要你确认。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "build 8 已运行，请重复最后一次双项验收。请照常输入，打错后使用退格也没关系。",
      status,
      "输入统计验收",
    ),
    "请重复最后一次双项验收。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "当前设置可继续。请回复“确认执行两项”，我将：",
      status,
      "更新设置",
    ),
    "请回复“确认执行两项”。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "现在请先按住 ⌘ 键，出现十字光标后拖框选中输入区，松开后回复我“框选好了”。如果遮罩已经消失，请点击重新框选。",
      status,
      "校准输入区",
    ),
    "现在请先按住 ⌘ 键，出现十字光标后拖框选中输入区，松开后回复我“框选好了”。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "有一个隐私变化需要你确认：需要保存当天的应用级汇总。你确认允许保存这些当天应用信息后，我就可以按这个方案实现。",
      status,
      "应用级统计",
    ),
    "你确认允许保存这些当天应用信息后，我就可以按这个方案实现。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "完成后回复“好了”，我会立即继续核验权限。",
      status,
      "权限核验",
    ),
    "完成后回复“好了”。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "你是否允许我点击官方微信的“进入微信”，做一次键盘和语音测试？",
      status,
      "测试微信输入",
    ),
    "你是否允许我点击官方微信的“进入微信”，做一次键盘和语音测试？",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "松开后回复我“框选好了”，我继续检查权限。",
      status,
      "校准输入区",
    ),
    "松开后回复我“框选好了”。",
  );
  assert.equal(
    notificationBodyFromAssistantReply(
      "下一张优先发京东金条64,552元的还款计划。",
      status,
      "整理个人负债",
    ),
    "下一张优先发京东金条64,552元的还款计划。",
  );
});

test("Unicode truncation counts code points instead of UTF-16 units", () => {
  assert.equal(truncateText("甲乙丙丁", 3, "fallback"), "甲乙丙…");
  assert.equal(truncateText("😀😀😀", 2, "fallback"), "😀😀…");
  assert.equal(normalizeTaskName("[一二三四五六七八九十一二三四五六七]"), "一二三四五六七八九十一二三四五六…");
});

test("notification display text strips bidi controls without breaking ZWJ emoji", () => {
  const bidiControls =
    "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";

  assert.equal(
    normalizeTaskName(`正常${bidiControls}任务`, "/tmp/fallback"),
    "正常任务",
  );
  assert.equal(
    shortenConversationName(`请检查${bidiControls}通知`, "/tmp/fallback"),
    "检查通知",
  );
  assert.equal(normalizeTaskName("开发者👨‍💻", "/tmp/fallback"), "开发者👨‍💻");

  const notification = formatNotification(
    { icon: "✅", label: "本轮结束" },
    `任务\u202eABC`,
    `对话\u2066XYZ`,
  );
  assert.equal(notification.title, "✅ [任务ABC]本轮结束");
  assert.equal(notification.body, "💬对话XYZ");
  assert.equal(/\p{Bidi_Control}/u.test(notification.title), false);
  assert.equal(/\p{Bidi_Control}/u.test(notification.body), false);
});

test("absolute local paths do not become task or conversation display text", () => {
  const localPaths = [
    "/Users/example/My Private Repo/secrets.txt",
    "/customRoot/example/PrivateRepo/secrets.txt",
    "///Users/example/PrivateRepo/secrets.txt",
    "////customRoot/example/PrivateRepo/secrets.txt",
    "~/Library/Logs/private.log",
    "C:\\Users\\example\\PrivateRepo\\secrets.txt",
    "\\\\server\\share\\PrivateRepo\\secrets.txt",
    "file:///Users/example/PrivateRepo/secrets.txt",
    "file:C:/Users/example/PrivateRepo/secrets.txt",
    "vscode://file/Users/example/PrivateRepo/secrets.txt",
    "%2FUsers/example/PrivateRepo/secrets.txt",
    "进度 100% %2FUsers%2Fexample%2FPrivateRepo",
    "%25252FUsers%25252Fexample%25252FPrivateRepo",
    "%2F%2F%2FUsers%2Fexample%2FPrivateRepo",
    "%2FcustomRoot%2Fexample%2FPrivateRepo",
    "\\Users\\example\\PrivateRepo\\secrets.txt",
    "路径:/Users/example/PrivateRepo/secrets.txt",
    "https://example.com,/Users/example/PrivateRepo/secrets.txt",
    "https://example.com)/Users/example/PrivateRepo/secrets.txt",
    "https://example.com/?file=/customRoot/example/PrivateRepo",
  ];

  for (const localPath of localPaths) {
    assert.equal(
      normalizeTaskName(`修复 ${localPath}`, "/tmp/fallback"),
      "fallback",
    );
    assert.equal(
      shortenConversationName(`请检查 ${localPath}`, "/tmp/fallback"),
      "fallback",
    );
  }

  assert.equal(normalizeTaskName("前端/后端", "/tmp/fallback"), "前端/后端");
  assert.equal(normalizeTaskName("./src/a.mjs", "/tmp/fallback"), "./src/a.mjs");
  assert.equal(normalizeTaskName("../src/a.mjs", "/tmp/fallback"), "../src/a.mjs");
  assert.equal(normalizeTaskName("前端 / 后端", "/tmp/fallback"), "前端 / 后端");
  assert.equal(normalizeTaskName("A / B", "/tmp/fallback"), "A / B");
  assert.equal(normalizeTaskName("A // B", "/tmp/fallback"), "A // B");
  assert.equal(normalizeTaskName("比例 1 / 2", "/tmp/fallback"), "比例 1 / 2");
  assert.equal(
    normalizeTaskName("src/private/config.mjs", "/tmp/fallback"),
    "src/private/conf…",
  );
  assert.equal(
    normalizeTaskName("packages/data/a.mjs", "/tmp/fallback"),
    "packages/data/a.…",
  );
  assert.equal(normalizeTaskName("foo/Users/bar", "/tmp/fallback"), "foo/Users/bar");
  assert.equal(
    normalizeTaskName("check/customRoot/example", "/tmp/fallback"),
    "check/customRoot…",
  );
  assert.equal(
    shortenConversationName("请检查 src/lib/text.mjs", "/tmp/fallback"),
    "检查 src/lib/text.mjs",
  );
  assert.equal(
    shortenConversationName("请检查 ./src/a.mjs", "/tmp/fallback"),
    "检查 ./src/a.mjs",
  );
  assert.equal(
    shortenConversationName("请检查 ../src/a.mjs", "/tmp/fallback"),
    "检查 ../src/a.mjs",
  );
  assert.equal(
    shortenConversationName("请检查 前端 / 后端", "/tmp/fallback"),
    "检查 前端 / 后端",
  );
  assert.equal(
    shortenConversationName(
      "请检查 src/private/config.mjs",
      "/tmp/fallback",
    ),
    "检查 src/private/config.mjs",
  );
  assert.equal(
    shortenConversationName(
      "请检查 check/customRoot/example",
      "/tmp/fallback",
    ),
    "检查 check/customRoot/example",
  );
  assert.equal(
    sanitizeNotificationText(
      "https://example.com/?next=/docs",
      "fallback",
    ),
    "https://example.com/?next=/docs",
  );
  assert.equal(
    sanitizeNotificationText(
      "https://example.com/#/route",
      "fallback",
    ),
    "https://example.com/#/route",
  );
  assert.equal(
    sanitizeNotificationText(
      "ftp://example.com/?next=/docs",
      "fallback",
    ),
    "ftp://example.com/?next=/docs",
  );
  assert.equal(
    sanitizeNotificationText(
      "git+ssh://example.com/#/route",
      "fallback",
    ),
    "git+ssh://example.com/#/route",
  );
  assert.equal(
    sanitizeNotificationText(
      "https://[::1]/#/route",
      "fallback",
    ),
    "https://[::1]/#/route",
  );
  assert.equal(
    sanitizeNotificationText(
      "custom+proto://[::1]/?next=/docs",
      "fallback",
    ),
    "custom+proto://[::1]/?next=/docs",
  );
  assert.equal(
    sanitizeNotificationText(
      "https://example.com/a_(b)/#/route",
      "fallback",
    ),
    "https://example.com/a_(b)/#/route",
  );
  for (const remoteRoute of [
    "https://example.com/#/private/settings",
    "https://example.com/#/Users/list",
    "https://example.com/?next=/data/list",
    "https://example.com/?route=/workspace/home",
  ]) {
    assert.equal(
      sanitizeNotificationText(remoteRoute, "fallback"),
      remoteRoute,
    );
  }
  assert.equal(
    sanitizeNotificationText(
      "https://example.com/?file=/Users/example/private.txt",
      "fallback",
    ),
    "fallback",
  );
  assert.equal(
    sanitizeNotificationText(
      "https://example.com/#file=/Users/example/private.txt",
      "fallback",
    ),
    "fallback",
  );
});

test("conversation cleanup skips a path-bearing line and uses the next safe line", () => {
  assert.equal(
    shortenConversationName(
      "请检查 /Users/example/private.txt\n整理通知文案",
      "/tmp/fallback",
    ),
    "整理通知文案",
  );
});

test("conversation cleanup removes metadata but preserves meaningful 同意", () => {
  const raw = `# Files mentioned by the user:

/private/example.png

# My request for Codex:

同意你的建议，帮我优化。后面内容不应进入简称。

\`\`\`js
const secret = "never";
\`\`\``;
  assert.equal(shortenConversationName(raw, "/tmp/work"), "同意你的建议，帮我优化");

  assert.equal(
    conversationNameFromPayload({
      cwd: "/tmp/work",
      "input-messages": ["旧问题", { text: "请你 帮我检查最新结果？" }],
    }),
    "检查最新结果",
  );
});

test("assistant summary extracts the first useful result and removes formatting", () => {
  assert.equal(
    shortenAssistantSummary(
      `已完成。

## 最终结果

通知正文现在会显示本轮回答摘要，全部 68 项测试通过。

\`\`\`js
const privateToken = "must-not-appear";
\`\`\``,
      "整理通知格式",
    ),
    "通知正文现在会显示本轮回答摘要，全部 68 项测试通过。",
  );
  assert.equal(
    shortenAssistantSummary(
      "好的，已经按你的方案优化完成。\n\n- 正文改为回答摘要",
      "整理通知格式",
    ),
    "正文改为回答摘要",
  );
  assert.equal(
    shortenAssistantSummary(
      "已更新 [text.mjs](/Users/example/private/text.mjs)，测试通过。",
      "整理通知格式",
    ),
    "已更新 text.mjs，测试通过。",
  );
});

test("assistant summary prefers a concrete sentence over acknowledgements and generic status", () => {
  assert.equal(
    shortenAssistantSummary(
      "我赞成。这比现在的“对话简称”更有价值。",
      "优化通知摘要",
    ),
    "这比现在的“对话简称”更有价值。",
  );
  assert.equal(
    shortenAssistantSummary(
      "已经帮你操作完成：\n- PermissionRequest Hook 已启用并信任。\n- 无需重启。",
      "信任新版 Hook",
    ),
    "PermissionRequest Hook 已启用并信任。",
  );
  assert.equal(
    shortenAssistantSummary(
      "## 验证结果\n\n**HTML 隐藏标记会直接显示，不能采用。**",
      "验证隐藏标记",
    ),
    "HTML 隐藏标记会直接显示，不能采用。",
  );
  assert.equal(
    shortenAssistantSummary(
      "此前配置失败。\n最终已经修复完成。",
      "修复通知",
    ),
    "最终已经修复完成。",
  );
  assert.equal(
    shortenAssistantSummary(
      "理解。\nBark 可以打开 ChatGPT，精确定位任务仍需实测。",
      "验证跳转",
    ),
    "Bark 可以打开 ChatGPT，精确定位任务仍需实测。",
  );
  assert.equal(
    shortenAssistantSummary(
      `理解。你想要的是：点击 Bark 后进入对应的 Codex 任务。

结论分两层：

- Bark 本身支持：推送中加入 \`url\` 参数，点击通知即可执行跳转。
- 精确定位具体任务仍需实测。`,
      "验证跳转",
    ),
    "Bark 本身支持：推送中加入 url 参数，点击通知即可执行跳转。",
  );
  assert.equal(
    shortenAssistantSummary(
      "更严谨地说：\n- 可以保证：点击 Bark 后打开 iPhone 的 ChatGPT。",
      "验证跳转",
    ),
    "可以保证：点击 Bark 后打开 iPhone 的 ChatGPT。",
  );
});

test("assistant summary removes hidden markers and avoids cutting a complete clause", () => {
  assert.equal(
    shortenAssistantSummary(
      "<!-- bark-summary: 不应显示 -->\n通知改为提取最终回答的具体首句。",
      "优化通知摘要",
    ),
    "通知改为提取最终回答的具体首句。",
  );
  assert.equal(
    shortenAssistantSummary(
      "重新扫描已完成并封存：28/28 个文件全部覆盖，发现 3 项低危问题；没有中危、高危或严重问题。",
      "重新扫描",
    ),
    "重新扫描已完成并封存：28/28 个文件全部覆盖，发现 3 项低危问题。",
  );
  assert.equal(
    shortenAssistantSummary(
      "很好，验证成功：点击 Bark 通知可以直接进入 ChatGPT 的 Codex Remote 界面。",
      "验证跳转",
    ),
    "点击 Bark 通知可以直接进入 ChatGPT 的 Codex Remote 界面。",
  );
  assert.equal(
    shortenAssistantSummary(
      "通知结果已确认：点击 Bark 通知可以直接进入 ChatGPT 的 Codex RemoteSettingsPanel 并显示结果。",
      "验证跳转",
    ),
    "通知结果已确认：点击 Bark 通知可以直接进入 ChatGPT 的 Codex…",
  );

  const prefix = "甲".repeat(42);
  for (const word of [
    "RemoteSettingsPanel",
    "configuration's",
    "configuration’s",
    "naïve",
    "nai\u0308ve",
  ]) {
    assert.equal(
      shortenAssistantSummary(`${prefix} ${word} 结果。`, "验证跳转"),
      `${prefix}…`,
    );
  }
});

test("assistant summary preserves semantic versions and useful semicolon clauses", () => {
  assert.equal(
    shortenAssistantSummary(
      "1.2.0 已安装，最后只差手动框选微信输入区。",
      "安装输入统计",
    ),
    "1.2.0 已安装，最后只差手动框选微信输入区。",
  );
  assert.equal(
    shortenAssistantSummary(
      "1.2.2 已安装，微信键盘与语音失效检测已启用。",
      "安装输入统计",
    ),
    "1.2.2 已安装，微信键盘与语音失效检测已启用。",
  );
  assert.equal(
    shortenAssistantSummary(
      "只需校准主微信；可移动，改大小会失效。",
      "校准微信输入区",
    ),
    "只需校准主微信；可移动，改大小会失效。",
  );
  assert.equal(
    shortenAssistantSummary("1. 第一项已经完成。", "处理任务"),
    "第一项已经完成。",
  );
  assert.equal(
    shortenAssistantSummary("1.第一项已经完成。", "处理任务"),
    "第一项已经完成。",
  );
});

test("assistant summary redacts credentials and falls back from unsafe text", () => {
  assert.equal(
    shortenAssistantSummary(
      "API key: abcdefghijklmnopqrstuvwxyz123456 已配置成功。",
      "配置 Bark 通知",
    ),
    "API key: [已隐藏] 已配置成功。",
  );
  assert.equal(
    shortenAssistantSummary(
      "已处理 /Users/example/private/secrets.txt",
      "配置 Bark 通知",
    ),
    "配置 Bark 通知",
  );
  assert.equal(
    shortenAssistantSummary(
      "已完成\u202eABC",
      "配置 Bark 通知",
    ),
    "已完成ABC",
  );
});

test("assistant summary and notification body use the wider 46-character limit", () => {
  const longSummary = "答".repeat(ANSWER_SUMMARY_CHARACTER_LIMIT + 1);
  const expected = `${"答".repeat(ANSWER_SUMMARY_CHARACTER_LIMIT)}…`;
  assert.equal(shortenAssistantSummary(longSummary, "回退"), expected);
  assert.equal(
    formatNotification(
      { icon: "✅", label: "本轮结束" },
      "示例任务",
      longSummary,
    ).body,
    `💬${expected}`,
  );
});

test("completion delay follows 5s base, +1s per 500 characters, 15s cap", () => {
  const delay = (length) =>
    completionDelayMilliseconds({
      "last-assistant-message": "字".repeat(length),
    });
  assert.equal(delay(0), 5_000);
  assert.equal(delay(499), 5_000);
  assert.equal(delay(500), 6_000);
  assert.equal(delay(999), 6_000);
  assert.equal(delay(1_000), 7_000);
  assert.equal(delay(5_000), 15_000);
  assert.equal(delay(50_000), 15_000);
});
