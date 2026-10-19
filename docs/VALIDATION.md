# 验证记录与剩余边界

日期：2026-10-19。版本：2.0.1。

## 已验证

`npm test`：18 项通过，使用 Node 内置测试运行器。

- 活跃分支回溯、替代分支排除、缺叶/断链/循环拒绝。
- Unicode 码点、中文估算、developer 与返回的思考摘要分开计量。
- 附件描述不 JSON 字符串化；用户配置文本不当作聊天轮次。
- 精确同源端点限制；不匹配其他域名或无关路径。
- 容量限制、上下文横幅、输入过长、只读、时间/模型额度分类。
- 两级阈值、未知/Work 模式禁用 Chat 提醒、设置白名单。
- SSE 分块、CRLF、多行事件、结束标记、事件大小边界。
- 原 fetch Promise/响应体/拒绝保持不变，不额外发请求。
- 旧会话异步响应与发送前启动的旧历史请求不会覆盖当前读数。
- JSON、init 和 SSE 信号必须关联到正确会话。
- 仓库已有脱敏 fixture 可解析；不产生 capacity limit/percentage。
- manifest 仅 storage API 权限，静态脚本仅匹配 chatgpt.com。

`test/dom.cjs`：在独立临时开发依赖 jsdom 26.1.0 中通过。它验证模拟 DOM 行为，不是实际扩展加载验证。

- 面板、唯一元素 ID、分支快照和发送后的局部计数。
- 字符变化更新、两级提醒、收起/稍后/忽略；局部统计缩小时保留本次已触发的提醒。
- 设置只写六项白名单，无聊天文本、会话 ID。
- Work/额度/硬限制分流、页面桥输入不能成为 HTML。
- SPA 换对话及旧 DOM 残留处理。
- 扩展没有产生额外 fetch。

依赖说明：生产扩展无 npm 运行时依赖。jsdom / Playwright 仅是可选开发测试工具，本次装在仓库外的临时目录，没有打入扩展。可在开发环境安装这些工具运行 `npm run test:dom`、`npm run test:browser`；如未安装，后两者不是默认测试命令。

## 未完成的真实浏览器验证

已尝试用 Playwright 加载真实 MV3 扩展，官方 Chrome for Testing 下载成功，但 Chromium 启动被执行环境的 Unix socket 权限限制阻止：`socket() failed: Operation not permitted`。没有绕过限制。

因此**不声称真实 Chrome/Edge 加载、页面布局、扩展 storage 隔离和实际 ChatGPT 兼容性已验证**。`test/browser.cjs` 保留实际浏览器回归步骤，使用本地拦截的模拟网站，不读取真实账号；允许启动浏览器的环境可继续执行。非默认 Chromium 路径可通过 CWM_CHROMIUM_PATH 指定。

建议用户首次安装后按 INSTALL.md 做一次正常使用验收。没有故意发送消息撞限额，没有真实触顶响应的端到端测试。

## 已知限制

- 没有可靠提前容量字段，阈值未经实测校准，可能过早或漏报。
- 通常需要手动指定 Chat；未知模式不默认认为 Chat。
- 发送后使用可见 DOM 局部统计，无法保证覆盖虚拟滚动/工具/附件，数字可能变小。完整快照不等于模型真实上下文。
- 同会话分支/编辑无法始终由 DOM 准确识别；已对消息按钮交互和可见 ID 变化保守降级，仍需实际网站检验。
- 只观察 fetch，不拦截 WebSocket。未知请求体/协议/超预算响应会被放弃观察。
- 仅显示观测到过的限制，尚未加入网站解除限制时的可靠复位协议；刷新/换对话清除。
- MAIN 世界并非可信边界，页面可能干扰或伪造统计。本扩展不基于统计自动执行动作。
- Chrome 权限依据：https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions 和 https://developer.chrome.com/docs/extensions/reference/api/storage 。

## 从哪里继续

1. 允许运行 Chromium 的环境执行 test/browser.cjs，完成真实安装及视觉验收。
2. 正常使用时观察 Chat 的读取路径与分支变化，优先补实际兼容性样本。
3. 若要经验校准，另行设计默认关闭、只记录计数和固定限制码的本机统计；不直接保存 HAR/聊天 JSON。

## 2.0.1 回归
用户截图确认 content.js 启动时共享核心对象缺失，但未能单独确认 core.js 缺失的具体原因。移除跨脚本全局加载依赖，两个运行入口分别在闭包内初始化核心。新增测试按 manifest 独立执行各入口，不预加载核心，并设置会抛异常的全局核心 getter 及宿主 module 对象。18 项核心测试及模拟 DOM 测试通过；真实 Chrome 加载仍待用户复测。
