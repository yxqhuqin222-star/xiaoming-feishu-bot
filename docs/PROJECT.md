# 小明飞书机器人项目文档

## 项目目标

小明是一个运行在本地的飞书机器人，用于在飞书私聊和群聊中以“小明”的人设进行简短回复，并承接后续日常播报能力。

当前核心目标：

- 私聊中可以直接回复用户消息。
- 群聊中只有被 @ 小明时才回复，避免群内每条消息都触发机器人。
- 使用 Kimi 生成回复。
- 天气、时间日期、部分最新消息先走实时查询工具，不直接让模型编。
- 通过飞书开放平台机器人身份回复原消息。
- 保留早安、知识卡、大道消息、摸鱼日历等播报能力的迁移规则。

## 当前实现

主程序：

- `bot.js`：飞书消息监听、轮询兜底、Kimi 回复生成、飞书消息回复。

文档：

- `docs/PROJECT.md`：项目总文档和当前事实入口。
- `docs/xiaoming-profile.md`：小明人设、回复风格、边界和关键配置。
- `docs/feishu-bot-runbook.md`：运行、验证、故障排查。
- `docs/broadcast-rules.md`：日常播报迁移规则。
- `docs/realtime-tools.md`：实时天气、时间、网页搜索能力。

配置示例：

- `.env.example`：本地环境变量模板，不保存真实密钥。
- `config/com.kityhello.xiaoming.plist`：macOS LaunchAgent 常驻监听服务配置模板。
- `config/xiaoming-broadcast.example.json`：播报配置示例。
- `config/xiaoming-system-prompt.md`：小明运行时读取的多行系统提示词。

脚本：

- `scripts/daily_broadcast.py`：播报内容生成与发送链路。
- `scripts/feishu_client.py`：飞书发送辅助逻辑。
- `scripts/learning_inventory.py`：知识库存管理辅助逻辑。

## 消息处理规则

服务同时使用两种消息来源：

- 事件监听：消费飞书 `im.message.receive_v1`。
- 轮询兜底：定时读取指定会话的新用户消息。
- 已处理消息 ID 会持久化到 `state/xiaoming-seen.json`；只有成功回复或明确忽略后才标记已处理，失败消息会在后续轮询中重试。

群聊规则：

- 默认必须 @ 小明才回复。
- @ 小明可以放在句首、句中或句末；可以和前面的中文连在一起，比如 `配置好了@小明`。
- 未 @ 小明的群消息只记录并跳过。
- 未 @ 小明时不调用 Kimi。
- 未 @ 小明时不发送错误提示或兜底回复。
- 私聊不需要 @ 小明。

相关配置：

```bash
FEISHU_REQUIRE_MENTION=true
FEISHU_BOT_MENTION_NAMES=小明
FEISHU_BOT_OPEN_ID=
```

说明：

- `FEISHU_REQUIRE_MENTION=true` 是默认规则。
- 如果群里的机器人显示名不是“小明”，需要把显示名追加到 `FEISHU_BOT_MENTION_NAMES`，多个名字用英文逗号分隔。
- `FEISHU_BOT_OPEN_ID` 只有在飞书事件提供结构化 mention ID 时才需要填写。

## 回复生成规则

1. 收到飞书用户消息。
2. 判断是否应该回复。
3. 应回复时，先判断是否命中实时工具。
4. 天气、时间日期、明确要求搜索或新闻类问题先查真实数据。
5. 未命中实时工具时，把消息内容交给 Kimi。
6. 优先使用 `BOT_SYSTEM_PROMPT_FILE` 指向的文件控制小明的人设与语气；未配置文件时才使用 `BOT_SYSTEM_PROMPT`。
7. 过滤模型返回中的 `<think>...</think>` 内容。
8. 按 `BOT_MAX_REPLY_CHARS` 截断过长回复。
9. 通过飞书 bot 身份回复原消息。

## 关键配置

真实密钥只放本地 `.env`，不要写进文档、代码或对话。

```bash
KIMI_API_KEY=你的 Kimi API Key
KIMI_MODEL=kimi-k3
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MAX_TOKENS=800

BOT_SYSTEM_PROMPT_FILE=config/xiaoming-system-prompt.md
BOT_SYSTEM_PROMPT=小明的人设与回复规则
BOT_MAX_REPLY_CHARS=260

FEISHU_REQUIRE_MENTION=true
FEISHU_BOT_MENTION_NAMES=小明
FEISHU_BOT_OPEN_ID=

FEISHU_POLL_CHAT_ID=飞书会话 ID
FEISHU_POLL_INTERVAL_MS=5000

FEISHU_BROADCAST_CHAT_ID=飞书播报目标会话 ID
FEISHU_MESSAGE_PREFIX=小明

REALTIME_TOOLS_ENABLED=true
REALTIME_DEFAULT_CITY=北京
REALTIME_SEARCH_ENABLED=true
REALTIME_SEARCH_TIMEOUT_MS=20000
```

## 常用命令

检查本地配置和飞书 CLI 登录状态：

```bash
npm run check
```

成功标志：

- 输出 `check passed`。

启动机器人：

```bash
npm start
```

成功标志：

- 输出 `event listener ready`。
- 输出 `polling fallback ready`。

一次性处理最新用户消息：

```bash
npm run reply-latest
```

成功标志：

- 如果最新消息应该回复，群里会出现机器人回复。
- 如果最新群消息没有 @ 小明，日志出现 `ignored ... bot was not mentioned`，且群里不会新增回复。

运行播报测试：

```bash
npm test
```

## 验收标准

机器人回复能力：

- 私聊发送消息，小明可以回复。
- 群聊发送普通消息，小明不回复。
- 群聊 @ 小明并提问，小明回复；句末 @ 小明也应被识别。
- 群聊未 @ 时，不调用 Kimi，不发送兜底错误消息。
- 问天气时，返回实时天气和降雨概率，不要求用户自己去查。
- 问时间日期时，返回北京时间。
- 明确要求搜索、新闻、热搜、最新新闻或最新消息时，返回搜索结果或明确说明搜索接口失败。
- 询问“最新要求”“最新配置”“现在的回复是否按要求”等内部规则问题时，不应误触发网页搜索。

运行能力：

- `npm run check` 通过。
- `npm start` 后事件监听和轮询兜底都进入 ready 状态。
- 修改正在运行的服务后，必须重启或热加载对应服务，并用真实日志或目标消息验证新规则已生效。

文档要求：

- 每次功能更新后，同步更新本项目文档。
- 运行方式变化更新 `docs/feishu-bot-runbook.md`。
- 人设、回复边界、触发规则变化更新 `docs/xiaoming-profile.md`。
- 播报口径变化更新 `docs/broadcast-rules.md`。
- 实时查询能力变化更新 `docs/realtime-tools.md`。
- 影响项目整体目标、当前能力或验收标准的变化更新本文件。

## 当前运行备注

当前已验证的运行目录曾位于：

```text
/Users/kityhello/Documents/Codex/2026-07-13/cli-https-open-feishu-cn-document/work/feishu-bot
```

当前整理后的项目目录为：

```text
/Users/kityhello/workplace/geren/xiaoming
```

后续应优先以整理后的项目目录作为权威项目文档和代码维护入口；如果实际服务仍从旧目录启动，功能更新需要同步到实际运行目录并重启服务。
