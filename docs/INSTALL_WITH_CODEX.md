# 通过 Codex 安装 codex-bark-notifier 指南

最快的方式是把本项目链接和你自己的 Bark Device Key 一起发给 **Mac 上的 Codex 本地任务**。Codex 会自动下载源码、寻找桌面 App 自带的运行时、执行完整测试和预演、完成安装，并只发送一条测试通知。你不需要预先手动安装 Node.js 或 Codex CLI。

> Bark Device Key 不是账号密码，但持有者可以向对应设备发送任意通知和点击链接。便捷模式会让 Key 进入本次 Codex 对话及可能的工具调用记录；“本地任务”表示任务能操作这台 Mac，不代表这些记录一定只保存在本机。不能接受这项留存时，请使用后面的隐藏输入方式。

使用前只需准备：

1. 在 iPhone 安装 Bark，并取得自己设备的 Bark Device Key。
2. 在 Mac 的 Codex 中新建一个本地任务。云端或远程任务无法配置这台 Mac。

## 方式 A：便捷自动安装

复制下面整段，只替换 Device Key 占位符：

```text
请直接在我的 Mac 本地安装并验证 Codex Bark Notifier，不要只给我操作说明：

https://github.com/jiangsir-tech/codex-bark-notifier

我的 Bark Device Key：
<粘贴你自己的 Device Key>

我选择便捷自动安装，并理解 Device Key 会进入本次 Codex 对话及可能的工具调用记录。不要在回复、命令输出或最终报告中重复、截取或展示它。

请按以下要求直接执行：

1. 先阅读仓库中的 README.md、SECURITY.md、安装器帮助和 CHANGELOG.md。
2. 确认当前任务确实运行在这台 Mac 上；如果只能在远程环境运行，请停止，不要处理 Device Key。
3. 自动下载仓库并确认来源是上面的公开地址。检查当前生效的 CODEX_HOME、已有 notify、Hooks 和安装清单；不得覆盖归属不明的配置，遇到冲突时安全停止并说明。
4. 不要要求我预先单独安装 Node.js 或 Codex CLI，也不要因为 PATH 中没有 codex 或 node 就停止。优先使用 scripts/install.sh 自动查找并验证 PATH、ChatGPT.app 或 Codex.app 自带的 Node.js 22+。不要擅自安装全局运行时、修改 PATH 或创建永久软链接；确实找不到兼容运行时再报告阻断。
5. 运行 sh scripts/install.sh --verify。测试失败时停止，不修改我的 Codex 配置。
6. 运行 sh scripts/install.sh --dry-run，记录实际 Codex Home、安装目录和配置合并计划。真实安装必须使用同一个 CODEX_HOME。
7. Device Key 已由我主动提供。不得把它放进 shell 命令、命令行参数、环境变量、URL、仓库文件、Codex 配置、Hook、项目日志或最终回复。请在交互式 TTY 中启动 sh scripts/install.sh，看到 Bark Device Key (input hidden): 后，只通过该进程的标准输入送入 Key；输入不得回显。如果当前工具不能安全使用交互式 TTY，请暂停并打开独立 Terminal，让我在隐藏提示中亲自粘贴，不要改用明文命令。
8. 安装后检查脚本语法、JSON/TOML 配置、备份、安装清单和文件权限。不得读取、搜索、哈希或输出 bark-device-key 的内容；只能确认它是当前用户所有的普通非链接文件且权限为 600。
9. 核对四种通知预览、主任务识别、子代理过滤、未知任务抑制、同轮去重，以及回答摘要只读取与 turn-id 精确匹配的 task_complete 最终回复。
10. 最多运行一次 sh scripts/install.sh --send-test。发送后暂停并问我 iPhone 是否实际显示；只有收到我的明确确认才能说“手机已收到”，不得仅凭 HTTP 或 Bark API 成功作出判断。
11. 收到我的确认后，自动查找 PATH、/Applications/ChatGPT.app/Contents/Resources/codex 和 /Applications/Codex.app/Contents/Resources/codex 中可用的交互式 CLI。给我一条精确启动命令；我运行后输入 /hooks，核对 PermissionRequest Hook 的 Event、Source 和 Command，再亲自选择 Trust。
12. 不得自动信任 Hook，不得写入或伪造信任状态，不得把用户 Hook 冒充 managed Hook，不得使用绕过 Hook trust 的参数。PermissionRequest Hook 只能提醒，不得自动批准或拒绝操作。
13. Hook 信任后提醒我退出 Hook CLI，并重启 Codex Desktop。最后报告安装与备份结果、测试数量、手机实测结果、四种通知的当前启用状态、已知限制，以及声音、图标、分组、点击链接、任务名称长度、摘要长度、完成延迟和状态判断规则等可调整项。
14. 除真实阻断、手机收件确认和 Hook 人工信任外，不要把正常流程拆成多轮让我操作。不要修改无关项目，也不要提交、推送或公开任何本机配置。

最终回复不得包含 Device Key。
```

标准本地任务能使用交互式 TTY、且没有配置冲突时，你通常只需要做两次确认：

1. 测试通知发出后，看一眼 iPhone，回复“已收到”或“未收到”。
2. 在 Codex CLI 的 `/hooks` 页面核对 `PermissionRequest` Hook，并选择信任。

Codex 的文件写入或联网操作仍可能触发其正常权限询问；这些是 Codex 自身的安全机制，不应被安装脚本绕过。

## 方式 B：隐藏输入，不把 Key 发进对话

如果不希望 Device Key 进入 Codex 对话，只发送仓库链接，并附上这句话：

```text
请在我的 Mac 本地安装并验证这个项目，但我不会把 Bark Device Key 发进对话：
https://github.com/jiangsir-tech/codex-bark-notifier

请自动阅读文档、下载源码，运行 sh scripts/install.sh --verify 和 sh scripts/install.sh --dry-run。不要要求我预先单独安装 Node.js 或 Codex CLI；先探测 PATH、ChatGPT.app 和 Codex.app 自带的兼容运行时。

预检全部通过后，在独立 Terminal 中启动 sh scripts/install.sh，让我只在 Bark Device Key (input hidden): 提示后亲自粘贴 Key。不要索要、读取、搜索、哈希、保存或转述 Key。安装后继续验证配置和权限，最多运行一次 sh scripts/install.sh --send-test，并引导我在 /hooks 中人工检查和信任 PermissionRequest Hook。不得自动信任、绕过信任或自动批准操作。
```

隐藏输入时，字符不显示是正常现象。安装结束后只告诉 Codex“安装器执行完成”，不要粘贴 Key 或包含 Key 的输出。

## Codex 最终应交付什么

完成安装和人工信任后，Codex 应给用户一份简短报告：

- 使用的 Node.js 路径与版本，以及完整测试结果；
- 实际 Codex Home、安装目录、配置修改和备份位置；
- 是否保留了已有 `notify` 和其他 Hooks；
- 唯一测试通知是否由用户确认在 iPhone 显示；
- 四种通知的格式和启用状态：

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

- 可按个人偏好调整的项目：声音、图标、分组、点击链接、任务名称长度、摘要长度、完成延迟和状态判断规则；
- 当前已知限制，以及以后如何更新或卸载。

如果找不到支持 `/hooks` 的 CLI，Codex 应明确报告：前三种通知已经可用，只有“需要你批准”暂未启用。它不应因此撤销已经成功安装的其他功能。

信任 Hook 前，应确认 `Event` 是 `PermissionRequest`，`Source` 是用户配置，`Command` 指向本机安装目录中的通知脚本。项目不会替你信任 Hook，也不会替你批准原始操作。
