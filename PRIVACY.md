# 隐私说明 — 接续提醒器 2.0.2
更新日期：2026-10-19。此 fork 非 OpenAI 官方扩展。

## 读取与内存处理
扩展在 chatgpt.com 页面中观察浏览器原本发出的、限定端点上的 fetch 响应，并读取页面已呈现的用户/助手消息，用于当前分支计数、文本 token 启发式估算和已知限制信号识别。

conversation JSON / SSE 在解析时会短暂存在内存；分页响应只提取本页消息计数、是否还有前页的布尔值、有界 num_turns 参数与固定读取状态；不跨页缓存原文或游标。完整正文不写入持久存储，不输出到控制台。分支计数、会话/消息标识、模式和固定限制码仅在当前页面内存中用于关联/显示。切换页面时重置。单个 JSON 观察上限 24 MiB，SSE 观察上限 32 MiB/180 秒，单事件缓冲上限约 1M 字符；超出会停止观察副本，不取消网页原请求。

不读取 Cookie、登录令牌、请求头或账号字段。请求体为页面提供的字符串时，仅短暂解析会话标识和来源用于关联，不保存正文。扩展与 ChatGPT 页面脚本共享 MAIN 世界；其他页面脚本可能影响观测结果，这不是防篡改监测器。

## 持久存储
仅使用 chrome.storage.local 的 cwmSettingsV2 键保存 enabled、mode、firstTurns、secondTurns、firstChars、secondChars 六项设置。不是 chrome.storage.sync，不通过浏览器同步上传设置。

不持久化聊天原文、完整 conversation JSON、conversation/message ID、标题、账号、Token、模型名称、限制事件或统计历史。暂缓/忽略状态仅在内存中，刷新后清除。卸载扩展清除其本机设置。

## 网络与代码
无新增主动请求、遥测、数据上传、远程 JavaScript、eval 或动态执行。响应通过 clone 观察，网页原 fetch 的参数、Promise、响应内容和失败结果保持原样。不会自动发送聊天、尝试绕过限额或调用外部 AI。

本版不观察 WebSocket，不保证获取所有网站限制事件。聊天内容仍由 ChatGPT 自身处理，其服务隐私规则独立于本扩展。

## 权限
- content_scripts.matches：仅 https://chatgpt.com/*，用于页面内观察和提醒。
- storage：用于本机设置。
无额外 host_permissions、tabs、cookies、webRequest、scripting、downloads 权限。
