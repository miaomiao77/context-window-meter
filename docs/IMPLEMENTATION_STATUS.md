# 接续提醒器实施检查点
更新时间：2026-10-19（Asia/Shanghai）
分支：codex/continuation-reminder
基线：a51b18431cb226ececd516e0443cf91d86d8d744
用户授权：基于调查改进 fork；暂不做接续按钮；分阶段持久保存，防止五小时额度中断。

## 范围
- 移除未经验证的模型窗口百分比/剩余量。
- 活跃分支统计、中文友好启发式 token 估算，明确不等于实际上下文。
- Chat 可配置两级接续提醒，Work/未知模式不沿用 Chat 阈值。
- 被动观察已有 conversation GET、init JSON、发送 JSON/SSE，白名单错误和限制信号。
- 默认只持久保存设置；不保存正文、完整 conversation、账号或会话标识。
- 不增加主动网络请求、不上传、不引入运行时依赖。
- 暂不接入 WebSocket；明确观测覆盖不足，不宣称能捕获所有限制。
- 主分支保持不变，交付可加载扩展和说明。

## 调查入口
Library: chatgpt-conversation-limit-investigation.md
Library ID: libfile_59d717eadcc88191aca333b5d1de3c52
证据索引 ID: libfile_245f10b5bef88191a478a1c4b09e573b
确认 conversation_too_large / context-truncation-block；未确认提前剩余量。
Work usage / model cap / input too large / read-only 不能等同会话容量耗尽。

## 阶段
1. [完成] 恢复基线、研究报告、建立分支及本检查点。
2. [完成] 统计核心、fetch 观察器、状态与提醒界面；当前候选 2.0.2。
3. [完成] 核心/模拟 DOM 回归、权限/存储核验、打包及说明；真实浏览器受环境限制，待用户验收。

## 恢复方法
读取本文件、git status、最新提交及 test/；从当前阶段继续。
阶段性提交保存到同名远程分支，不只保存在临时工作区。


### 检查点 2：首版实现完成，尚未验证
已写 core.js、page_script.js、content.js、styles.css，manifest 2.0.0。仅本机 storage 设置权限，移除冗余 host_permissions。
后续：替换旧百分比测试，验证 SSE/JSON 错误分流、异步导航、设置持久化、浏览器加载；修复测试发现问题后打包。
已知实现边界：发送后快照失效，改用明确标注的 DOM 局部统计；新历史快照到达才恢复完整分支计数。没有 WebSocket 拦截。自动模式无法确认 Chat 时需要手动指定。

### 检查点 3：核心测试通过，浏览器执行受环境限制
17 项 Node 核心测试通过。正常下载官方 Chrome for Testing 后，启动被当前执行环境拒绝 Unix socket（Operation not permitted），尚未完成真实 Chromium 扩展加载验证，不绕过限制。正在补做模拟 DOM 交互测试；浏览器回归脚本 test/browser.cjs 可在允许运行 Chromium 的开发环境执行。安装、隐私、打包脚本已完成。

### 最终检查点：2.0.0 可安装候选版
17 项核心测试及模拟 DOM 交互回归通过；修复了导航时旧 DOM 残留、响应副本异常清理、DOM 根 ID 冲突等问题。真实 Chromium 因环境 socket 限制未能启动，详见 VALIDATION.md，尚未经过真实账号网站验收。
已移除不可靠容量百分比，提供两级可调提醒、手动 Chat 模式、已知服务端限制分类及最小本机设置存储。接续按钮按用户要求未做。
交付包含安装包、INSTALL.md 和独立分支；主分支不变。下一步是用户安装验收/可运行浏览器环境的回归，不应重新调查全部前端代码或重复旧审计。

### 2.0.1：用户实测启动崩溃修复
2026-10-19 用户截图：Uncaught TypeError: Cannot read properties of undefined (reading settings)，content.js:5。共享核心对象缺失，具体此前为何未定义尚未证实。
改为 core.js 纯工厂 + src/ 入口源码，用 scripts/build.py 生成两个各自包含核心的运行脚本；manifest 不再独立加载 core.js。禁止依赖全局共享核心的启动回归已加入，18 项核心测试和 DOM 测试通过。下一步请用户覆盖升级到 2.0.1、重载扩展并刷新 ChatGPT，观察真实运行结果。

### 2.0.2：复数历史接口与局部统计修复
2026-10-19 用户确认 2.0.1 UI 正常，实际 GET /backend-api/conversations/{id}?num_turns=10&include_has_versions=true 没有读数。
确认三个原因：matcher 只匹配旧单数、解析器只读 mapping、UI 桥将历史数据强制标为 complete。
公开官方前端还证实新接口返回 messages/page_info，由网页合成 mapping；新增 /messages 分页观察。证据 URL、脚本哈希、函数与局限见 PAGINATION_EVIDENCE.md。
修复精确路由及 GET 限制，支持消息页和分页 mapping 片段；保留 partial 语义，不跨页累加、不主动补历史。诊断区分未捕获、待响应、已解析、不支持和读取失败；不输出正文、游标或 URL 标识。
27 项 Node 测试、模拟 DOM 回归通过；实际 Chromium 仍受原环境限制，浏览器脚本仅完成更新与语法检查。生成 2.0.2 安装包并随源码保存至同名远程分支。
下一步：用户覆盖升级、重载扩展并刷新 ChatGPT，核对“本页消息统计”和固定诊断。没有完整跨页 active branch 前，不应把本页数量当作总量或剩余容量；不重做整个审计，也不把分页片段相加来凑总量。
