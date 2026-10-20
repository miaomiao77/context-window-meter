# ChatGPT 复数历史接口证据

调查日期：2026-10-19。目的：修复 2.0.1 未捕获新历史接口，以及将分页片段误标为完整分支的风险。

## 用户实测与代码缺口

用户观察到 GET `/backend-api/conversations/{conversation_id}?num_turns=10&include_has_versions=true`，2.0.1 UI 正常但没有计数。检查仓库确认旧 matcher 只有单数 `/conversation/{id}`，解析器要求 mapping，UI 桥又固定设置 complete=true。

## 官方公开前端代码

来源：[主 bundle](https://chatgpt.com/cdn/assets/4813494d-cb22y2w19zwyshmt.js)。UTF-8 文件 SHA256：`2fd6628ef4df35b1ef8b4ee240ce0530752c4e73f5b4ee43a9142fa74b7aaa54`。

以下是代码行为摘要，不附整份第三方 bundle；偏移为 Python Unicode 字符索引，并非字节偏移。文件名和压缩函数名可能随网站更新变化。

| 函数 / 偏移 | 观察到的行为 | 对扩展的意义 |
| --- | --- | --- |
| D8t / 2289854 | 请求复数 conversation 详情，带 num_turns、include_has_versions，可带 include_message_id；读取 messages/page_info | 只修路径不足，还需适配原始消息数组 |
| _8t / 2287243 | 按消息顺序构造父链与合成根，拒绝重复 ID | 前端合成的根不证明全历史已加载 |
| C8t / 2289223 | has_previous_page 为真时采用 start_cursor | 这里只是分页信息，不是剩余容量信号 |
| T8t / 2289400 | 组装消息页状态、游标与 oldestMessageId | 单页与整段 conversation 数据是不同层次 |
| O8t / 2290901 | 请求复数 /messages，带 before、num_turns、include_has_versions，返回另一消息页 | 可被动观察后续自然请求，不能简单将页计数相加 |

D8t 会在返回转换后的对象中选择存在于本页映射的 current_node，否则使用该页消息或合成根。因此原始页的 current_node 不在数组中，或旧页没有 current_node，并不等于该页消息无法计数。空初始页还可能由网页继续请求更早页；扩展没有复刻这种请求行为。

另一公开入口：[conversation-small bundle](https://chatgpt.com/cdn/assets/conversation-small-fym1zmu9zimymmm1.js) 按实验参数选择分页分支或旧版路径。这不能证明所有账号、所有页面都使用新接口。

## 2.0.2 采用的边界

- 旧单数接口继续支持；复数详情与 /messages 仅观察 GET、同源、精确路径。
- 复数消息数组只计本页顶层消息，不展开 versions；没有将分页参数解释为对话总轮数。
- 复数响应始终标注局部，has_previous_page=false 也不单独作为完整 active branch 证据。
- 重复页替换读数而不累计；不同页暂不合并。分页 mapping 只沿当前节点父链读取已返回片段。
- 不新增历史请求，不保存聊天原文或游标，不读取登录信息。诊断只包含固定枚举与有界数字。
- 官方公开静态代码支持上述结构适配；没有读取用户私有会话，也没有完成 2.0.2 在真实账号上的端到端验收。

消息页完整度与会话容量是两个问题。此调查没有发现或声称新增的提前 remaining/limit 信号；修复读数并不意味着已能可靠预警硬上限。
