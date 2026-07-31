# 发布检查清单

这是一份维护者清单，不是用户安装步骤。项目采用“GitHub 源码仓库 + GitHub Releases”发布，首版不发布 npm 包，也不使用 `curl | bash`。

## 首次公开前

1. 确认仓库中不存在 Device Key、个人绝对路径、真实会话内容和私有日志。
2. 确认 README 中的安装、更新和卸载命令与当前代码一致。
3. 在全新临时 `CODEX_HOME` 中运行安装、重复安装、更新和卸载测试。
4. 在包含既有 `notify` 与其他 Hooks 的测试环境中验证配置合并。
5. 验证默认卸载保留私有数据，`--purge` 才删除，并且两者都不会覆盖用户后续配置。
6. 运行：

   ```bash
   npm run test:all
   ```

7. 检查公开图标 URL、官方文档链接和仓库内部链接。
8. 准备脱敏截图；截图不得出现 Device Key、用户名、项目私有名称或其他通知内容。
9. 确认 README 明确写出非 OpenAI 官方项目、硬崩溃边界和内部元数据非稳定 API。
10. 让至少一位未参与开发的 macOS + Bark 用户按公开文档完成安装与卸载。

## v0.1.0 发布流程

1. 把 `CHANGELOG.md` 中的 `Unreleased` 改为实际发布日期。
2. 确认版本号在代码、`package.json` 与 Changelog 中一致。
3. 合并经过审查和 CI 验证的改动。
4. 创建带注释的 Git Tag：

   ```bash
   git tag -a v0.1.0 -m "Codex Bark Notifier v0.1.0"
   git push origin v0.1.0
   ```

5. 在 GitHub 创建 `v0.1.0` Release，正文包含：
   - 解决的核心问题；
   - 四种通知状态；
   - 支持的平台和 Node.js 版本；
   - 安装与 Codex CLI `/hooks` 信任入口；
   - 已知限制；
   - 从旧个人脚本迁移时的注意事项。
6. Release 标记为正式版前，再从 GitHub 下载发布内容，在独立临时目录运行一次 `npm run test:all`。

## 首版之后

- `v0.1.x`：修复兼容性、判断规则、文档和安装器问题，不引入破坏性配置变化。
- `v0.2.0`：新增平台、配置项或改变安装结构时使用，并提供迁移说明。
- 安全修复需要在 `SECURITY.md`、Changelog 和 Release Notes 中明确影响范围。
- 不要把“某一次本机测试成功”写成对所有 Codex 版本的兼容承诺。

## 为什么暂不发布 npm 包

首版的主要风险在 Codex 配置合并、Hook 信任和卸载边界，而不在包下载。GitHub 源码仓库更方便用户和 Codex 在安装前审查真实代码，也避免把尚未稳定的安装接口过早固化成全局 npm 工具。
