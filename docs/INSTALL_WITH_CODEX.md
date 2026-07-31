# 交给你自己的 Codex 安装

下面的提示词适合直接复制给运行在你自己 Mac 上的 Codex。不要把 Bark Device Key 粘贴进 Codex；即使 Codex 在本机运行，对话和工具输入也可能被保存。

使用前请准备：

1. 在 iPhone 安装 Bark。
2. 在 Terminal 运行 `command -v codex`；如果没有输出，先按 [Codex CLI 官方安装页](https://learn.chatgpt.com/docs/codex/cli)完成安装。即使平时只用 Codex Desktop，也需要 CLI 的 `/hooks` 页面信任批准通知 Hook；如果已安装的 CLI 没有 `/hooks` 命令，请先更新 CLI。
3. 确保这个仓库已经下载到本机，或者把仓库地址一并发给 Codex。
4. 准备稍后打开一个独立的 macOS Terminal；Device Key 只会在那里输入。

## 可复制提示词

```text
请直接在我的 Mac 上安装并验证 Codex Bark Notifier：

https://github.com/jiangsir-tech/codex-bark-notifier

重要安全边界：我不会把 Bark Device Key 发给你。你不得索要、读取、保存、显示或转述它，也不得让我把它粘贴到 Codex 对话、工具输入、命令行参数、环境变量、临时文件或仓库文件中。

请在本机完成除密钥输入以外的检查和验证。具体要求：

1. 先阅读仓库 README、SECURITY.md、安装器帮助和当前版本说明。
2. 确认系统是受支持的 macOS，Node.js 满足项目要求，并运行 command -v codex 确认 Codex CLI 可用；如果没有输出，停止安装并让我先按官方 Codex CLI 文档完成安装。不要把“命令存在”等同于“支持 Hooks”；如果稍后在 CLI 中找不到 /hooks，必须先让我更新 CLI。
3. 运行 npm run test:all；测试失败时先定位原因，不要继续修改我的 Codex 配置。
4. 先确定当前生效的 Codex Home：设置了 CODEX_HOME 时使用它，未设置时才使用 ~/.codex。检查该目录中的 config.toml、notify 和 Hooks，并在安装前创建带时间戳的备份；不得因为默认路径存在就忽略 CODEX_HOME，后续验证以安装器输出的实际路径为准。
5. 不得覆盖已有通知器和无关 Hooks，必须使用安装器提供的合并逻辑。
6. 先运行 node scripts/install.mjs --dry-run，确认安装目标、备份和配置合并计划合理。
7. 到真正安装时必须暂停，只给我一条不含 Device Key 的命令。dry-run 和真实安装必须使用同一个 Codex Home；如果第 4 步发现非默认 CODEX_HOME，真实安装命令必须携带同一个非敏感 CODEX_HOME，并正确进行 shell 引用。默认路径时格式为：

   node '/仓库绝对路径/scripts/install.mjs'

   非默认路径时格式为：

   env CODEX_HOME='/实际 Codex Home' node '/仓库绝对路径/scripts/install.mjs'

   让我在独立的 macOS Terminal 中亲自运行。你不得替我启动交互安装器。提醒我确认真实安装输出的 Codex Home 与 dry-run 完全相同；如果不同，立即停止，不输入 Device Key。
8. 提醒我看到 Bark Device Key (input hidden): 后再粘贴 Key；输入不显示字符是正常现象。安装结束后，我只回复“安装器执行完成”，不粘贴 Key 或包含 Key 的输出。
9. 收到我的完成回复后，再检查脚本语法、JSON/TOML 配置、文件权限和备份路径。不得读取、搜索、哈希或输出 bark-device-key 的内容；只能验证路径存在、是普通非符号链接文件、属于当前用户且权限为 600。
10. 核对四种通知预览严格符合：

   ✅ [任务名称]本轮结束
   💬回答摘要

   🔁 [任务名称]需要你回复
   💬回答摘要

   ⛔ [任务名称]受阻或出错
   💬回答摘要

   🔐 [任务名称]需要你批准
   💬本轮请求简称

11. 验证回答摘要只读取与通知 turn-id 精确匹配的 task_complete 最终回复；缺失时回退本轮请求简称，不能读取下一轮或中间进度。再验证主任务完成事件、子代理过滤、未知任务抑制和相同事件去重。
12. 最多发送一条明确标注的真实 Bark 测试通知，不要制造通知风暴。发送后必须暂停并询问我手机是否实际显示；只有收到我的明确确认后，才能报告“手机已收到”，不得仅凭 HTTP 或 Bark API 返回成功作出判断。
13. PermissionRequest Hook 只能发送提醒，不得自动批准或拒绝操作。
14. 告诉我需要在 Codex CLI 的 `/hooks` 页面检查和信任哪个 Hook；不要把桌面任务输入框误写成 Hook 管理入口，也不要替我绕过信任机制。
15. 提醒我重启 Codex，再新建一个小任务测试“本轮结束”，并触发一次真实批准请求测试“需要你批准”。
16. 不要修改这个仓库以外的无关项目，也不要提交、推送或公开任何本机配置。

完成后请汇报：

- 安装和修改了哪些文件；
- 备份保存在哪里；
- 是否保留了已有 notify 和 Hooks；
- 项目测试、配置检查、主任务/子代理/去重测试的结果；
- 手机是否收到唯一一条测试通知（只能依据我的明确确认）；
- 还需要我在 Codex CLI 中完成哪些 `/hooks` 信任或重启步骤；
- 当前版本的已知限制。

最终回复中确认你从未接收、读取或输出 Bark Device Key。
```

## 安装后由你完成

Codex 完成预检并暂停后，你需要亲自完成四件事：

1. 在独立的 macOS Terminal 运行 Codex 给出的安装命令，在隐藏提示后输入 Device Key。
2. 回到 Codex 只回复“安装器执行完成”，让它继续做非密钥内容验证。
3. Codex 发送唯一一条测试通知并暂停后，根据 iPhone 的实际显示明确回复“已收到”或“未收到”。
4. 在 Terminal 运行 `codex`，进入 Codex CLI 后输入 `/hooks`，检查并信任新增 Hook；如果没有 `/hooks` 命令，先按官方 Codex CLI 页面更新 CLI。重启 Codex Desktop 后再进行普通任务和批准请求测试。

信任 Hook 前，应确认命令指向你本机安装的 Node 与 Codex Bark Notifier 脚本。不要信任来源不明或包含陌生命令的 Hook。
