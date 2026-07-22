# 小明飞书机器人资料

## 基础定位

- 名称：小明
- 类型：飞书机器人
- 角色定位：一个清醒、温柔、嘴直心软、表达自然的年轻女性好友型助手。
- 关系设定：同性恋语境下的恋人兼朋友。
- 使用场景：飞书私聊中可直接回复；飞书群聊中只有被 @ 小明时才回复。
- 项目用途：存放小明机器人的项目文档、人设、回复规则、运行配置说明和后续知识内容。
- 项目总文档：[PROJECT.md](/Users/kityhello/workplace/geren/xiaoming/docs/PROJECT.md)。
- 信息来源：历史任务 `019f5944-9ea3-7ae2-9ff1-8d3679954fbc`。

## 已实现链路

```text
用户在飞书里发消息
→ 本地 Node.js 服务监听飞书消息
→ 调用 Kimi 生成回复
→ 通过飞书开放平台机器人身份回复
```

已验证过的能力：

- 能通过本地脚本收到飞书 bot 会话消息。
- 能调用 Kimi 生成回复。
- 能用飞书 bot 身份把回复发回会话。
- 能回答实时天气、时间日期；能对“查一下/搜一下/最新新闻”类问题做网页搜索兜底。
- 服务同时启用了事件监听和轮询兜底。
- 轮询只回复服务启动后的新消息，不自动回复启动前历史消息。
- 群聊默认必须 @ 小明才回复；未 @ 的群消息只记录并跳过，不调用 Kimi，也不发送兜底回复。

## 个性化配置

小明不再使用强硬导师风格。新的默认风格是温和、简练、自然，有判断但不压人。

核心口径：

- 普通寒暄、确认、轻量问题，用自然、柔和、短句回复。
- 用户只是叫小明或问“在吗”时，轻轻接住，例如“在呢，怎么啦？”。
- 用户需要建议时，先给可执行方向，再补充必要理由。
- 用户的想法、计划、措辞或假设有漏洞时，先承认合理部分，再指出关键问题。
- 不因为用户语气自信就默认赞同，但表达要留有余地。
- 不说狠话，不制造压迫感，不把普通问题上升成人格分析。

## 技术信息摘要

- 本地服务语言：Node.js ESM。
- Node.js 版本要求：>= 20。
- 主要脚本：`bot.js`。
- 启动命令：`npm start`。
- 检查命令：`npm run check`。
- 一次性回复最新消息：`npm run reply-latest`。
- 飞书命令行工具：`lark-cli`。
- 飞书事件：`im.message.receive_v1`。
- Kimi 模型：`kimi-k3`。
- Kimi 接口：`https://api.moonshot.cn/v1`。
- 实时工具文档：[realtime-tools.md](/Users/kityhello/workplace/geren/xiaoming/docs/realtime-tools.md)。

## 关键配置项

真实密钥只放本地 `.env`，不要写进文档或代码。

```bash
KIMI_API_KEY=你的 Kimi API Key
KIMI_MODEL=kimi-k3
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MAX_TOKENS=800
BOT_SYSTEM_PROMPT=小明的人设与回复规则
BOT_SYSTEM_PROMPT_FILE=config/xiaoming-system-prompt.md
BOT_MAX_REPLY_CHARS=260
FEISHU_REQUIRE_MENTION=true
FEISHU_BOT_MENTION_NAMES=小明
FEISHU_BOT_OPEN_ID=
FEISHU_POLL_CHAT_ID=飞书会话 ID
FEISHU_POLL_INTERVAL_MS=5000
REALTIME_TOOLS_ENABLED=true
REALTIME_DEFAULT_CITY=北京
REALTIME_SEARCH_ENABLED=true
REALTIME_SEARCH_TIMEOUT_MS=20000
```

说明：

- 小明运行时优先读取 `BOT_SYSTEM_PROMPT_FILE` 指向的多行系统提示词文件。
- `BOT_SYSTEM_PROMPT` 只作为备用配置；直接写多行内容不会完整生效。

## 群聊接入规则

- 不能把 Incoming Webhook 直接“加到”开放平台机器人上。
- Incoming Webhook 只能往群里发消息，不能读群消息。
- 要在群里聊天，必须把“小明”这个开放平台应用机器人添加到目标群。
- 群聊里默认只回复 @小明 的消息，避免群里每句话都触发。
- 未 @ 小明的群消息不会调用模型，也不会回复错误提示。
- 如果群里的机器人显示名不是“小明”，需要把显示名追加到 `FEISHU_BOT_MENTION_NAMES`，多个名字用英文逗号分隔。
- 群聊需要确认机器人具备群消息相关权限和事件订阅能力。

## 播报能力

小明需要承接从 `jump` 项目迁移来的日常播报规则，详见 [broadcast-rules.md](/Users/kityhello/workplace/geren/xiaoming/docs/broadcast-rules.md)。

已整理的播报类型：

- 早安
- 三分钟知识卡
- 午间新闻
- 大道消息
- 摸鱼日历
- 晚间收尾

迁移口径：

- 内容生成规则保留。
- 去重、归档和发送前预览规则保留。
- 钉钉 webhook、钉钉签名和钉钉关键词不迁移。
- 飞书版发送目标改为飞书私聊或群聊。

## 敏感信息处理

- Kimi API Key 不写入文档。
- 飞书 webhook 完整地址不写入文档。
- `.env` 不应提交或外传。
- 如果 webhook 曾经被贴到公开对话里，建议在飞书后台重置后再使用。

## 待补充信息

- 小明的服务对象是谁。
- 小明主要解决什么问题，是陪聊、提醒、业务问答，还是工作助手。
- 小明可以回答哪些问题。
- 小明不能回答哪些问题。
- 是否需要固定开场白或结束语。
- 是否需要为小明增加更多群聊触发别名。
- 是否需要接入飞书审批、日程、文档或知识库。
- 是否需要长期常驻运行，以及运行在哪台机器上。

## 后续建议

后续新增内容时，可以继续按以下分类补充：

- `docs/`：机器人说明、规则、人设、需求文档。
- `config/`：飞书应用配置模板，不保存真实密钥。
- `scripts/`：启动、测试或部署脚本。
- `data/`：知识库、样例问答、测试数据。
- `tests/`：自动化测试或回复样例检查。
