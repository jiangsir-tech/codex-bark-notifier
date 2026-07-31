# Codex Bark Notifier

[直接安装](#4-复制给-codex-安装)

## 1. 这是做什么的

目前 Mac 上的 Codex 跑完任务后，iPhone 不会收到通知，这有点影响效率。

这个项目借助手机上的 Bark 解决了这个问题，还针对通知体验做了一些优化。

## 2. iPhone 上的通知效果

![iPhone 锁屏上的四类 Codex Bark 通知](assets/screenshots/bark-four-statuses-lock-screen.png)

目前有四种通知：

```text
✅ [任务名称]本轮结束
💬回答摘要

🔁 [任务名称]需要你回复
💬回答摘要

⛔ [任务名称]受阻或出错
💬回答摘要

🔐 [任务名称]需要你批准
💬本轮请求简称
```

通知里会显示任务名称和简短结果。点击后，会跳转到 iPhone 上 ChatGPT 的 Codex 页面。

## 3. 做了哪些优化，还有哪些不足

做过的优化：

- 尽量等 Codex 回答完整后再通知，减少“手机响了，电脑还在输出”的情况。
- 自动过滤子代理和中间步骤，避免一个任务连续通知很多次。
- 同一轮自动去重，不会因为重复事件反复推送。
- 区分本轮结束、需要回复、受阻出错和需要批准。
- 多个任务同时运行时，会显示各自的任务名称。
- 前三种通知会提取本轮回答的简短总结；需要批准时，会显示本轮请求简称。
- 需要批准时会立即提醒，不用等整轮结束。
- 支持调整通知图标、铃声、分组、摘要长度、完成延迟和跳转链接。
- 安装后的 Device Key 保存在本机私有文件里，不写进项目代码和普通日志。

目前还有这些不足：

- 目前只测试了 macOS、iPhone 和 Bark，还没有测试 Windows 或 Android。
- “需要回复”和“受阻或出错”靠文本判断，偶尔可能判断错。
- Codex 或系统突然崩溃时，可能来不及发送通知。
- 点击通知只能进入 Codex Remote，暂时不能保证打开对应任务。
- “需要你批准”的 Hook 必须由用户亲自检查并信任，不能自动跳过。
- Codex 更新后如果内部事件格式变了，项目可能也要跟着调整。

## 4. 复制给 Codex 安装

先在 iPhone 安装 Bark，然后找到自己的 Device Key。

Bark 里的推送地址一般长这样：

```text
https://api.day.app/你的DeviceKey/推送内容
```

`api.day.app/` 后面的那串字符就是 Device Key。每个人都要使用自己 Bark 里的 Key。

![Bark Device Key 所在位置](assets/screenshots/bark-device-key-location.png)

打开 Mac 上的 Codex Desktop，新建一个本地任务，把下面整段复制过去，只替换最后一行：

```text
请直接在我的 Mac 上安装并验证这个项目，不要只告诉我怎么操作：
https://github.com/jiangsir-tech/codex-bark-notifier

请先阅读仓库里的安装指南，然后自动完成下载、环境检查、完整测试、dry-run 和安装。优先使用 Mac 上已有 Codex 或 ChatGPT App 自带的运行环境，不要因为 PATH 里没有 node 或 codex，就让我另外手动安装。

Device Key 可以用于这次安装，但不要在回复、日志或命令中重复显示。安装完成后只发送一条测试通知，并让我确认手机是否收到。

接着带我检查并信任 PermissionRequest Hook。这一步需要我亲自确认，不要绕过。

全部弄好后，请告诉我：
1. 哪些通知已经可以使用；
2. 四种通知分别会怎么显示；
3. 图标、铃声、分组、摘要长度、完成延迟和跳转链接还能怎么调整。

我的 Bark Device Key：
<粘贴你自己的 Device Key>
```

后面如果 Codex 让你确认测试通知，或者让你检查 Hook，照着提示操作就行，其他步骤都交给 Codex。

Device Key 不是 Apple ID 或 ChatGPT 密码，但别人拿到后可以给你的 Bark 发通知，所以不要把它放进公开仓库、Issue 或截图。把 Key 发给 Codex 后，它会留在这次对话和可能的工具记录里。

更完整的安装检查和安全边界在[安装指南](docs/INSTALL_WITH_CODEX.md)和[安全说明](SECURITY.md)里。
