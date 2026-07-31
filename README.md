# Codex Bark Notifier

> Mac 上的 Codex 任务完成，手机上并不会有通知。此项目用 bark 解决了 iOS 手机上无通知的问题，并进行了些体验上的优化。

[5 分钟开始](#5-分钟开始) · [交给 Codex 安装](docs/INSTALL_WITH_CODEX.md) · [查看已知限制](#已知限制)

![iPhone 锁屏上的四类 Codex Bark 通知](assets/screenshots/bark-four-statuses-lock-screen.png)

> iPhone 实机演示。任务名称和正文均为虚构示例，不包含 Device Key、真实任务 ID 或私人对话。

## 手机上会看到什么

通知使用四种固定格式。标题说明状态和任务；前三种正文显示本轮回答摘要，批准通知因为尚无最终回答，正文保留本轮请求简称：

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

- **任务名称**：优先使用 Codex 侧边栏名称，最多 16 个 Unicode 字符。
- **回答摘要**：从该轮已封口最终回复中提取首个具体结论，清理格式、路径、链接和明显凭据后，最多 46 个 Unicode 字符。
- **本轮请求简称**：批准通知尚无最终回复时使用，最多 30 个 Unicode 字符。
- **图标、分组和声音**：默认使用 Codex 风格图标、`Codex` 分组和 `minuet` 声音。
- **点击通知**：在 iPhone 上打开 ChatGPT 的 Codex Remote；当前不承诺精确定位到对应任务。

## 普通 bark 通知与针对 Codex 优化的后的 bark 通知区别

| 简单通知脚本的常见问题 | 本项目的处理 |
| --- | --- |
| Codex 还在输出，手机已经提示完成 | 精确读取本轮最终回复，再延迟 5～15 秒推送 |
| 子代理每结束一次都通知 | 只通知可确认属于用户主任务的完成事件 |
| 同一轮重复触发 | 使用 `thread-id + turn-id` 持久化去重 |
| 所有情况都显示“完成” | 区分结束、需要回复、受阻出错、需要批准 |
| 多个任务同时运行时无法辨认 | 标题显示任务名称，正文显示回答摘要 |
| 点击通知后仍要手动寻找 Codex | 携带 ChatGPT 任务链接，打开 Codex Remote |
| 密钥写在脚本、URL 或命令行中 | 安装后的长期 Key 只保存在本机私有文件 |
| 通知失败后无法排查 | 保留不记录密钥和对话正文的 JSONL 审计日志 |

完成通知来自 Codex 官方 `agent-turn-complete` 外部通知事件；批准提醒来自官方 `PermissionRequest` Hook。Hook 只负责提醒，不会替你批准、拒绝或绕过 Codex 的信任机制。

## 适用范围

适合以下用户：

- 在 macOS 上使用 Codex Desktop 或 Codex CLI；
- 使用 iPhone 和 [Bark](https://github.com/Finb/Bark)；
- 经常运行需要数分钟甚至更久的 Codex 任务；
- 希望只在任务结束或被识别为需要介入时回到电脑前。

当前版本面向 macOS，运行时需要 Node.js 22 或更高版本。`scripts/install.sh` 会自动查找 PATH、ChatGPT.app 或 Codex.app 自带的兼容 Node.js；普通用户不需要预先手动安装 Node.js 或 Codex CLI。其他操作系统尚未承诺支持。

“本轮结束”“需要你回复”和“受阻或出错”安装后即可工作。“需要你批准”还需要用户在 Codex CLI 的 `/hooks` 页面亲自检查并信任 `PermissionRequest` Hook；安装流程会优先寻找桌面 App 自带的 CLI，不会因为 PATH 中没有 `codex` 命令就要求重新安装。Hook 信任不能也不会被自动绕过。

## 5 分钟开始

> Bark Device Key 不是 Apple ID、ChatGPT 账号密码或设备解锁凭据，但持有者可以向这台设备发送任意通知正文和点击链接，因此只使用自己的 Key，不要放进公开仓库、Issue 或截图。为了最省事，你可以主动把它交给自己 Mac 上的本地 Codex；此时 Key 会进入本次对话及可能的工具调用记录，介意留存时请改用下面的隐藏输入方式。

### 在 Bark 哪里找 Device Key

打开 iPhone 上的 Bark，进入底部的“服务器”页面。页面里的推送示例地址类似：

```text
https://api.day.app/[DEVICE_KEY]/推送内容
```

`api.day.app/` 后、下一个 `/` 前的那一段就是 Bark Device Key。只复制这一段，并确保每位用户使用自己设备生成的 Key；不要把完整真实地址放进公开仓库、Issue 或截图。

![Bark Device Key 所在位置的脱敏示意图](assets/screenshots/bark-device-key-location.png)

### 方式 A：链接和 Key 一起发给 Codex（推荐）

1. 在 iPhone 安装 Bark，并取得当前设备的 Device Key。
2. 在 Mac 上新建一个 **Codex 本地任务**。不要使用只能在云端运行、无法访问这台 Mac 配置的远程任务。
3. 把下面整段发给 Codex，只替换最后一行的占位符：

```text
请直接在我的 Mac 本地安装并验证这个项目，不要只给我操作说明：
https://github.com/jiangsir-tech/codex-bark-notifier

请按仓库中的“通过 Codex 安装 codex-bark-notifier 指南”执行：自动下载源码、检查环境、运行完整测试和 dry-run，再完成安装。优先使用 Mac 上现有 Codex/ChatGPT App 自带的 Node.js 与 Codex CLI；不要仅因 PATH 中没有命令就让我另行安装。

除我刚刚主动提供的本次对话外，Codex 后续只能把 Device Key 送入安装器隐藏 TTY 的标准输入；不要把它放进 shell 命令、命令行参数、环境变量、日志、仓库文件或最终回复，也不要重复显示它。安装后最多发送一条测试通知并暂停，等我确认手机是否实际收到。随后协助我完成 PermissionRequest Hook 的人工检查与信任；不要自动批准、写入信任状态或绕过信任。最后列出四种通知的实际格式、当前启用状态和可个性化的项目。

我的 Bark Device Key：
<粘贴你自己的 Device Key>
```

4. 标准本地任务能使用交互式 TTY 时，Codex 会自动完成环境检查、测试、预演、安装和一条真实测试推送；如果当前工具无法安全向隐藏输入发送 Key，才需要你在独立 Terminal 中粘贴一次。测试通知发出后，请根据 iPhone 实际显示回复“已收到”或“未收到”。
5. 为启用“需要你批准”，Codex 会找到 PATH 或桌面 App 自带的 CLI，并给你一条精确启动命令。运行后输入 `/hooks`，核对 `PermissionRequest` 命令并确认信任一次；退出 Hook CLI 后重启 Codex Desktop。
6. 安装结束时，Codex 应告诉你四种通知是否可用，并列出声音、图标、分组、点击链接、任务名称长度、摘要长度、完成延迟和状态判断规则等可调整项。

完整提示词、检查标准和失败边界见 [通过 Codex 安装 codex-bark-notifier 指南](docs/INSTALL_WITH_CODEX.md)。

### 方式 B：不把 Key 发进对话

如果介意 Device Key 留在对话或工具历史中，只把仓库链接发给 Mac 本地 Codex，并要求它完成下载、测试和 `--dry-run`。正式安装时让 Codex 在独立 Terminal 中运行 `sh scripts/install.sh`；看到 `Bark Device Key (input hidden):` 后由你粘贴 Key，输入过程不会显示字符。之后仍由 Codex 继续验证、发送一条测试通知并引导 Hook 信任。

### 方式 C：手工安装

```bash
git clone https://github.com/jiangsir-tech/codex-bark-notifier.git
cd codex-bark-notifier
sh scripts/install.sh --verify
sh scripts/install.sh --dry-run
sh scripts/install.sh
```

`scripts/install.sh` 会自动寻找 Node.js 22+，隐藏 Device Key 输入，并备份、合并现有 Codex 配置。它不会接受 `--key <secret>`。如果 PATH 中没有兼容 Node.js，它会继续尝试 ChatGPT.app 与 Codex.app 的内置运行时；全部找不到时才停止并说明缺少什么。

`--dry-run` 与真实安装必须输出同一个 Codex Home。设置了非默认 `CODEX_HOME` 时，应在同一个 Terminal 会话中连续运行两条命令，避免环境变量丢失。

高级自动化可使用 `sh scripts/install.sh --key-file /absolute/path/to/private-key-file`。参数接收的是仓库外、权限为 `600` 的私有文件路径，不是 Key 本身；安装器会拒绝符号链接、硬链接和不安全权限，并且调用方应在安装后立即删除临时源文件。

如果 `--dry-run` 报告现有 `notify` 或 Hooks 已被其他程序修改，请停止，不要强制覆盖。安装器的拒绝是为了保护已有配置。

### 安装后验证

1. 以安装器输出的 Codex Home 和安装目录为准。安装器会自动使用当前 `CODEX_HOME`；未设置时才使用 `~/.codex`。
2. 让 Codex 依次查找 PATH、`/Applications/ChatGPT.app/Contents/Resources/codex` 和 `/Applications/Codex.app/Contents/Resources/codex`。启动找到的交互式 CLI 后输入 `/hooks`；确认新增命令指向上述安装目录内的通知脚本，再选择信任。只有这些位置都没有兼容的 Hook 管理界面时，才需要按 [官方说明](https://learn.chatgpt.com/docs/codex/cli)安装或更新 CLI；这不会影响另外三类通知。
3. 重启 Codex。
4. 只运行一次安装后的测试命令，验证 Mac 到 Bark 的链路。下面的命令会自动寻找兼容 Node.js，并使用当前 Terminal 中的 `CODEX_HOME`；未设置时使用 `~/.codex`：

   ```bash
   sh scripts/install.sh --send-test
   ```

5. 如果安装器输出的实际路径与当前 Terminal 的 `CODEX_HOME` 不同，请使用安装器输出的完整脚本路径。
6. 根据 iPhone 的实际显示确认是否收到测试通知；HTTP 请求成功本身不能证明通知已显示在手机上。

![Codex CLI 中已启用并信任的 PermissionRequest Hook](assets/screenshots/codex-cli-hooks-trusted.png)

图中 `[x] Hook 1` 表示 Hook 已启用，`Trust  Trusted` 表示当前命令已经受信任。该脱敏示意图根据实际界面整理，已隐藏用户名、本机绝对路径和无关启动日志。

## 基础配置

公开配置示例见 [examples/config.example.json](examples/config.example.json)。默认安装位置是 `~/.codex/notifications/codex-bark/`；设置 `CODEX_HOME` 后使用对应目录。

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `bark.endpoint` | `https://api.day.app/push` | Bark JSON POST 地址，也可改为自建服务 |
| `group` | `Codex` | Bark 通知分组 |
| `sound` | `minuet` | 通知声音 |
| `icon` | 项目公开图标 URL | 通知左侧自定义图标 |
| `requestTimeoutMilliseconds` | `8000` | HTTP 请求超时 |

敏感的 Device Key 不在 JSON 中，而是保存在权限为 `600` 的 `bark-device-key` 私有文件中。图标使用无需登录即可访问的 HTTPS URL；Bark 会缓存相同 URL，换图时应更换文件名或版本参数。

如果希望回答摘要更稳定，可以在个人 `AGENTS.md` 中要求最终回答首句给出可独立理解的具体结论，并尽量控制在 42 个可见字符以内。通知器仍会自行跳过空泛开场、清理敏感内容，并执行 46 字出口上限；安装器不会自动修改 `AGENTS.md`。

## 工作原理

```text
Codex 主任务本轮结束
        │
        ▼
agent-turn-complete
        │
        ├─ 确认主任务归属
        ├─ 精确读取该 turn-id 的最终回复
        ├─ 分类、清理、去重
        └─ 延迟 5～15 秒
                    │
                    ▼
              Bark → iPhone

Codex 即将请求批准
        │
        ▼
PermissionRequest Hook
        │
        └─ 即时提醒，不自动批准
```

为提取任务名称、父子任务关系和回答摘要，项目会尽力而为地只读解析 Codex 本地会话元数据。找不到精确匹配的 `task_complete` 最终回复时，正文退回本轮请求简称，不会拿下一轮或中间进度替代。无法确认属于主任务的完成事件会被抑制。

官方参考：[Codex notifications](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Bark 自定义推送图标](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)。

## 隐私与安全

- 项目安装后的 Device Key 长期副本只保存在本机私有文件，不写入源码、Codex 配置、Hook、日志或后台任务；便捷模式中用户主动发给 Codex 的 Key 仍可能留在对话和工具记录中。
- 审计日志不记录密钥、用户对话正文、最终回复或完整 HTTP 请求。
- 后台任务只保存线程、轮次、状态和延迟等最小引用数据。
- 通知正文会把清理和截断后的摘要发送到所配置的 Bark 服务；介意公共服务时可使用自建 Bark Server。
- 点击跳转会携带不透明的 Codex 任务 ID，但不包含任务正文或 ChatGPT 登录凭据。
- 不要在公开 Issue 中粘贴密钥、完整配置、私密路径、原始日志或未脱敏截图。

完整安全模型和私密报告方式见 [SECURITY.md](SECURITY.md)。

## 常见问题

- **手机没有通知**：检查 Bark 通知权限、网络、Device Key 和审计日志中的 `failed`。
- **完成有通知，批准没有**：让 Codex 先查找 PATH 或桌面 App 自带的 CLI，在其中打开 `/hooks` 检查并信任 Hook，确认脚本路径存在，然后重启 Codex；只有所有候选都不支持 `/hooks` 时才需要安装或更新 CLI。
- **一轮收到多次完成通知**：检查是否仍安装旧版 `Stop` Hook 或另一套 Bark 通知，并在日志中查找 `suppressed_subagent`、`suppressed_duplicate`。
- **通知到了，Codex 仍在输出**：完成通知默认延迟 5～15 秒；批准通知不会延迟。
- **图标仍是 Bark 图标**：检查公开 HTTPS 图片 URL；更新图标时更换 URL 以避开缓存。
- **失败却显示本轮结束**：状态来自文本规则，不是 Codex 权威状态；提交问题时只提供脱敏后的最小示例。

## 更新与卸载

更新前查看 [CHANGELOG.md](CHANGELOG.md)，然后运行：

```bash
git pull --ff-only
sh scripts/install.sh --verify
sh scripts/install.sh --dry-run
sh scripts/install.sh
```

如果预览报告受管 `notify` 或 Hooks 已变化，请停止并人工核对，不要强制覆盖。

默认卸载保留 Device Key、日志和备份：

```bash
sh scripts/install.sh --uninstall --dry-run
sh scripts/install.sh --uninstall
```

确认不再需要任何私有数据时才使用 `sh scripts/install.sh --uninstall --purge`。`--purge` 删除一旦开始便不可逆；它只处理固定的受管路径，不会猜测性修改无法安全恢复的 Codex 配置。

## 已知限制

- 当前只面向并测试 macOS 与 Node.js 22+。
- 如果安装时使用桌面 App 内置 Node.js，通知配置会记录当时的绝对路径；以后删除 App 或其内部目录发生变化时，需要重新运行安装更新路径。
- Codex、通知进程或系统在事件产生前硬崩溃时，可能来不及通知。
- “需要回复”和“受阻或出错”依赖文本规则，存在误判和漏判可能。
- Codex 内部会话结构不是稳定公共 API，增强解析可能随 Codex 更新失效。
- 为避免误报，无法确认属于主任务的完成事件会被抑制，可能造成少量漏报。
- 当前已测试版本中，点击任务链接可进入 Codex Remote，但不保证精确定位到对应任务；该行为可能随 ChatGPT 或 iOS 更新变化。
- 项目不会监控每个内部步骤，也不提供远程控制或自动批准。

## 开发与发布

运行 `npm run test:all` 可执行语法检查和完整测试。发布前还应在独立临时环境验证安装、重复安装、更新、卸载、既有 `notify`/Hooks 合并以及真实 Bark 推送。

维护者检查清单见 [docs/RELEASING.md](docs/RELEASING.md)。

## 许可证与声明

本项目原创代码和项目文档使用 [MIT License](LICENSE)。第三方名称、图标、商标和素材不包含在该授权中，详见 [NOTICE.md](NOTICE.md)。

Codex Bark Notifier 是独立社区项目，不是 OpenAI 官方产品，也与 OpenAI、Codex 或 Bark 无隶属、赞助或官方合作关系。
