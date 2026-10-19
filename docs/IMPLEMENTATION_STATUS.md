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
2. [进行中] 共享统计核心、fetch 观察器、状态与提醒界面。
3. [待做] 回归测试、浏览器测试、权限/存储核验、打包及安装说明。

## 恢复方法
读取本文件、git status、最新提交及 test/；从当前阶段继续。
阶段性提交保存到同名远程分支，不只保存在临时工作区。
