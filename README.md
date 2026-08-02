# Codex Bark Notifier

[快速安装 Codex Bark Notifier](#4-复制给-codex-安装)

## 1. 这是做什么的

Mac 上跑本地 Codex 任务时，如果没有配置或无法使用 Codex Remote，iPhone 通常收不到任务结果或人工确认提醒。任务比较久，人离开电脑后容易错过。

这个项目用 iPhone 上的 Bark 补上一条通知通道，还针对重复推送、通知时机、状态判断和显示格式做了优化。

`v0.1.0` 只支持 macOS，运行时需要 Node.js 22 或更新版本；CI 实际测试 Node.js 22 和 24。它是独立社区项目，不是 OpenAI 官方产品，也没有得到 OpenAI 的赞助或背书。

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

通知里会显示任务名称和简短结果。点击后会尝试打开 ChatGPT 的 Codex 任务链接；在 iPhone 上通常会进入 Codex Remote 页面，但由 App 还是网页打开、能否精确定位到对应任务，取决于 iOS、ChatGPT 登录状态和链接路由，项目不能保证。

## 3. 做了哪些优化，还有哪些不足

做过的优化：

- 尽量等 Codex 回答完整后再通知，减少“手机响了，电脑还在输出”的情况。
- 自动过滤子代理和中间步骤，避免一个任务连续通知很多次。
- 同一轮自动去重，不会因为重复事件反复推送。
- 区分本轮结束、需要回复、受阻出错和需要批准。
- 多个任务同时运行时，会显示各自的任务名称。
- 前三种通知会提取本轮回答的简短总结；需要批准时，会显示本轮请求简称。
- 需要批准时会立即提醒，不用等整轮结束。
- 安装后的 `config.json`（通常在 `~/.codex/notifications/codex-bark/`）可以直接调整 Bark 服务地址、通知图标、铃声、分组和请求超时，字段见[公开配置示例](examples/config.example.json)。服务地址默认必须使用 HTTPS；只有本机联调时，才可显式放行回环地址的 HTTP。
- 安装后的 Device Key 保存在本机私有文件里，不写进项目代码和普通日志。

目前还有这些不足：

- `v0.1.0` 只支持 macOS，安装器会拒绝 Windows 和 Linux；手机端只验证了 iPhone + Bark，Android 不在当前支持范围内。
- 需要 Node.js 22 或更新版本；自动化测试覆盖 Node.js 22 和 24，不能把这理解为对所有未来 Node.js 版本的兼容承诺。
- “需要回复”和“受阻或出错”靠文本判断，偶尔可能判断错。
- Codex 或系统突然崩溃时，可能来不及发送通知。
- 点击通知只能尝试打开通用任务链接，不能保证进入 App 或精确定位到对应任务。
- “需要你批准”的 Hook 必须由用户亲自检查并信任，不能自动跳过。
- Codex 更新后如果内部事件格式变了，项目可能也要跟着调整。
- 回答摘要长度、任务名称长度、完成延迟、点击链接和状态判断规则目前是源码中的固定行为，不是公开配置项；要改变这些规则，需要修改源码并重新安装。
- 正常配置下，通知标题、摘要和 Device Key 会以普通 JSON 经 HTTPS 发往你配置的 Bark 服务；当前版本没有实现 Bark 的内容加密模式。内容敏感时，请自行评估公共 Bark 服务，或改用受信任的 HTTPS 自建服务。本机联调可以显式放行回环地址的 HTTP，但不应用于远程 Bark 服务。

## 4. 复制给 Codex 安装

> 🟣 **步骤 1｜获取 Bark Device Key**
>
> 先在 iPhone 上安装 Bark，找到并复制自己的 Device Key。

![Bark Device Key 所在位置](assets/screenshots/bark-device-key-location.png)

Device Key 不是 Apple ID、ChatGPT 密码或设备解锁凭据，但别人拿到后可以向这台 Bark 设备发送任意通知正文和点击链接。

下面的便捷方式会让 Key 进入这次 Codex 对话及可能的工具调用或服务端留存记录。如果不能接受，请不要粘贴 Key，改用[独立 Terminal 隐藏输入方式](docs/INSTALL_WITH_CODEX.md#方式-b隐藏输入不把-key-发进对话)。无论用哪种方式，正常配置下的通知标题、回答摘要和 Device Key 都会以普通 JSON 经 HTTPS 发往配置的 Bark 服务；`v0.1.0` 还没有实现 Bark 内容加密。

> 🟣 **步骤 2｜交给 Codex 自动安装**
>
> 打开 Mac 上 ChatGPT 桌面端里的 Codex（或 Codex 桌面端），新建一个本地任务，把下面整段复制过去，只替换最后一行：

```text
请直接在我的 Mac 上安装并验证这个项目，不要只告诉我怎么操作：
https://github.com/jiangsir-tech/codex-bark-notifier/tree/v0.1.0

请只使用 `v0.1.0` Tag 对应的源码，不要改用 main 分支或其他版本。先阅读这个版本里的安装指南，然后自动完成下载、版本核对、环境检查、完整测试、dry-run 和安装。优先使用 Mac 上已有 Codex 或 ChatGPT App 自带的运行环境，不要因为 PATH 里没有 node 或 codex，就让我另外手动安装。

我选择便捷安装，并理解 Device Key 会进入这次 Codex 对话及可能的工具调用或服务端留存记录。Device Key 可以用于这次安装，但不要在回复、日志或命令中重复显示。安装完成后只发送一条测试通知，并让我确认手机是否收到。

接着带我检查并信任 PermissionRequest Hook。这一步需要我亲自确认，不要绕过。

全部弄好后，请告诉我：
1. 哪些通知已经可以使用；
2. 四种通知分别会怎么显示；
3. `config.json` 中的 Bark 服务地址、图标、铃声、分组和请求超时这些公开配置还能怎么调整；
4. 哪些显示或判断规则只有修改源码才能改变。

我的 Bark Device Key：
<粘贴你自己的 Device Key>
```

后面如果 Codex 让你确认测试通知，或者让你检查 Hook，照着提示操作就行，其他步骤都交给 Codex。

更完整的安装检查和安全边界在[安装指南](docs/INSTALL_WITH_CODEX.md)和[安全说明](SECURITY.md)里。

## 5. 复制给 Codex 更新

下面这段会把现有安装更新或校准到稳定版本 `v0.1.0`，不需要再次提供 Device Key。以后项目发布新版本时，请使用对应版本文档里的更新提示词，不要自行追踪会变化的 `main` 分支。

```text
请直接在我的 Mac 上把已经安装的 Codex Bark Notifier 更新或校准到 v0.1.0，不要只告诉我怎么操作：
https://github.com/jiangsir-tech/codex-bark-notifier/tree/v0.1.0

请只使用 `v0.1.0` Tag 对应的源码，不要改用 main 分支或其他版本。先阅读这个版本的 README、安装指南、CHANGELOG 和安装器帮助，然后直接执行：

1. 确认当前是能操作这台 Mac 的本地任务，并检查实际生效的 CODEX_HOME、现有安装清单、notify、Hooks 和公开配置。
2. 在新的临时目录获取 `v0.1.0` Tag，并核对实际检出的版本和 commit；不要覆盖已有源码目录或里面未提交的改动。发现 Tag 不存在、来源不明的改动或配置冲突时，安全停止并告诉我。
3. 复用本机已经保存的 Bark Device Key，不要让我重新提供，也不要读取、搜索、哈希、输出或转述它；如果 Key 缺失就停止并告诉我。
4. 使用同一个 CODEX_HOME，先运行 sh scripts/install.sh --verify，再运行 sh scripts/install.sh --dry-run。任何测试或预演失败都要停止，不修改现有安装。
5. 预检通过后运行 sh scripts/install.sh 完成更新。保留我的自定义 config.json、原有 notify、其他 Hooks 和备份。
6. 更新后核对安装清单、文件权限和四种通知。最多运行一次 sh scripts/install.sh --send-test，然后让我确认 iPhone 是否实际收到；不能只凭请求成功判断手机已经收到。
7. 检查 PermissionRequest Hook 是否仍然可信；只有 /hooks 显示它是新增、已变化或未信任时，才引导我核对后亲自信任。不得自动信任、伪造信任状态或绕过 Hook trust。

最后告诉我更新到的版本、commit SHA、测试数量、保留了哪些设置，以及是否需要重启正在使用的 ChatGPT/Codex 桌面端。不要修改无关项目，也不要提交或推送仓库。
```

## 6. 复制给 Codex 卸载

下面默认使用可恢复卸载：停止通知并恢复 Codex 配置，但保留 Device Key、公开配置、日志和备份，避免误删。

```text
请直接在我的 Mac 上安全卸载 Codex Bark Notifier，不要只告诉我怎么操作：
https://github.com/jiangsir-tech/codex-bark-notifier/tree/v0.1.0

请只使用 `v0.1.0` Tag 对应的源码，不要改用 main 分支或其他版本。先阅读这个版本的 README、安装指南、SECURITY、卸载器帮助，然后直接执行：

1. 确认当前是能操作这台 Mac 的本地任务，在新的临时目录获取 `v0.1.0` Tag，核对实际检出的版本和 commit，并检查实际生效的 CODEX_HOME 和安装清单。不要覆盖已有源码目录或里面未提交的改动；Tag 不存在时安全停止。
2. 不要读取、搜索、哈希、输出或转述 Bark Device Key。先运行 sh scripts/install.sh --verify，再运行 sh scripts/install.sh --uninstall --dry-run。
3. 如果预演确认能够安全恢复安装前的 notify 和 Hooks，就运行 sh scripts/install.sh --uninstall；如果配置已经被改动、无法安全恢复，就停止并告诉我，不要强行覆盖。
4. 不要使用 --purge。卸载后确认安装清单标记为已卸载，临时 state 和 jobs 已清理；只移除本项目管理的 notify、PermissionRequest Hook 和未被修改的受管运行文件，保护本地修改过的文件。
5. 确认原有 notify、其他 Hooks 和后来增加的用户配置没有被误删。告诉我删除了什么，保留了哪些 Device Key、公开配置、日志、卸载清单和备份，以及是否需要重启正在使用的 ChatGPT/Codex 桌面端。不要发送测试通知，也不要修改无关项目或推送仓库。

只有我之后明确要求“彻底删除所有保留数据”时，才能先说明 --purge 不可恢复的删除范围和可能留下悬空 Codex 配置的情况，再执行 --purge。本轮不得使用它。
```
