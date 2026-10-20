# 隐私说明 — 接续提醒器 2.1.0
更新日期：2026-10-20。此 fork 非 OpenAI 官方扩展。

## 默认被动观察
仅在 chatgpt.com 观察网页原本发出的限定 fetch JSON/SSE，以及已呈现的用户/助手文本。原始响应副本短暂在内存中解析，正文不写存储或控制台。MAIN 观察器不读取 Cookie、请求头或登录令牌；字符串请求体只提取会话关联与模式。

单个被动 JSON 上限 24 MiB，SSE 上限 32 MiB/180 秒，单事件约 1M 字符。超出只停止观察副本，不取消网站请求。没有 WebSocket 观察。

## 用户主动扫描（相对 2.0.2 的新增行为）
只有隔离世界 UI 的真实点击才能启动。页面消息桥没有启动命令，合成点击不能启动扫描。

- 请求同源 `/api/auth/session`，仅使用响应 accessToken；不使用账号/邮箱等字段，不调用登录刷新或其他账号接口。
- 临时令牌只在扩展 ISOLATED 闭包中持有，用 Authorization 头向固定同源 `/backend-api/conversations/{id}` 及 `/messages` 发起 GET。浏览器按同源规则携带登录 Cookie，扩展不通过 Cookie API 读取其值。
- 不信任响应提供的 next URL；根据固定路径与编码后的游标构造请求，redirect=error。令牌不经 MAIN 消息桥、DOM、日志或 storage；结束、取消、错误后释放引用。这不是内存安全擦除保证。
- 每页正文只短暂解析，跨页仅保留消息 ID、父节点（若存在）、统计摘要、SHA256 文本摘要哈希和游标；这些都仅在内存中。结束后删除去重索引/哈希/游标，只保留当前显示需要的计数与消息 ID；刷新/导航清除。
- 依次读取，页间至少 350ms；最多 500 页、100000 个节点、64 MiB 总响应、单页 24 MiB、会话响应 1 MiB、约 5 分钟、单请求 30 秒。可取消。401/403/429 不自动重试。明确 Work 来源会停止。
- 扫描不修改、发送、删除或归档聊天，不操作剪贴板，不向第三方传输内容。

页面与其他扩展仍可能干扰 DOM、显示或网络；MAIN 桥不能视为可信监测来源。ISOLATED 保护私有 JS 变量，不是浏览器/页面完全被攻陷时的安全保证。

## 持久存储
仅 chrome.storage.local 的 cwmSettingsV2：enabled、mode、firstTurns、secondTurns、firstChars、secondChars 六项设置。不使用 storage.sync。

不持久化聊天原文、完整 conversation JSON、conversation/message ID、标题、账号、令牌、文本哈希、游标、模型名、限制事件或统计历史。暂缓/忽略提醒状态只在内存中。卸载会清除本机设置。

## 网络与代码
默认无新增请求；点击手动扫描后只有上述 ChatGPT 同源只读请求。无遥测、第三方上传、远程脚本、eval 或运行时 npm 依赖。被动观察仍保持网站原 fetch 参数、Promise、响应内容及失败结果不变。

聊天内容仍由 ChatGPT 自身处理，其服务规则独立于扩展。扩展不尝试绕过限额。

## 权限
静态内容脚本仅匹配 https://chatgpt.com/*；唯一 API 权限 storage。无额外 host_permissions、tabs、cookies、webRequest、scripting 或 downloads。

实现依据：Chrome 的内容脚本隔离与同源网络规则：
- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
