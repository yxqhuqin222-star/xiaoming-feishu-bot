# 小明飞书机器人运行说明

项目总文档见 [PROJECT.md](/Users/kityhello/workplace/geren/xiaoming/docs/PROJECT.md)。

## 当前来源

旧项目目录：

```text
/Users/kityhello/Documents/Codex/2026-07-13/cli-https-open-feishu-cn-document/work/feishu-bot
```

旧项目包含：

- `package.json`：定义 `start`、`check`、`reply-latest`。
- `bot.js`：机器人主程序。
- `.env.example`：配置模板。
- `README.md`：旧版运行说明。

当前项目已经放入可运行骨架：

- `bot.js`：飞书私聊/群聊监听与 Kimi 回复。
- `config/com.kityhello.xiaoming.plist`：macOS LaunchAgent 常驻监听服务配置模板。
- `scripts/daily_broadcast.py`：日常播报生成与发送入口。
- `scripts/feishu_client.py`：通过 `lark-cli` 发送飞书文本消息。
- `scripts/learning_inventory.py`：三分钟知识卡动态库存。
- `data/`：心理学冷知识、摸鱼日历、晚间收尾文案。
- `config/xiaoming-broadcast.example.json`：小明飞书版播报配置模板。
- `docs/realtime-tools.md`：实时查询能力说明。

## 运行依赖

- Node.js >= 20
- `lark-cli`
- 已登录并可用的飞书 CLI 身份
- 可用的 Kimi API Key
- 飞书开放平台机器人权限

## 本地配置

创建 `.env`，不要提交真实文件。

```bash
KIMI_API_KEY=你的 Kimi API Key
KIMI_MODEL=kimi-k3
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MAX_TOKENS=800

BOT_SYSTEM_PROMPT_FILE=config/xiaoming-system-prompt.md
BOT_SYSTEM_PROMPT=小明的人设与回复规则
BOT_MAX_REPLY_CHARS=260

FEISHU_POLL_CHAT_ID=飞书会话 ID
FEISHU_POLL_INTERVAL_MS=5000

REALTIME_TOOLS_ENABLED=true
REALTIME_DEFAULT_CITY=北京
REALTIME_SEARCH_ENABLED=true
REALTIME_SEARCH_TIMEOUT_MS=20000
```

说明：

- Kimi API 使用 `https://api.moonshot.cn/v1`。
- 模型默认使用 `kimi-k3`。
- API Key 使用 Kimi 开放平台生成的密钥，不要写入文档或代码。
- `BOT_SYSTEM_PROMPT_FILE` 优先级高于 `BOT_SYSTEM_PROMPT`，用于保存多行人设和回复规则；`BOT_SYSTEM_PROMPT` 只作为备用。

## 自动常驻监听

当前聊天监听可以使用 macOS LaunchAgent 常驻运行，配置模板在：

```text
/Users/kityhello/workplace/geren/xiaoming/config/com.kityhello.xiaoming.plist
```

安装位置：

```text
/Users/kityhello/Library/LaunchAgents/com.kityhello.xiaoming.plist
```

日志位置：

```text
/Users/kityhello/Library/Logs/xiaoming/feishu-listener.log
/Users/kityhello/Library/Logs/xiaoming/feishu-listener-error.log
```

常用检查：

```bash
launchctl print gui/$(id -u)/com.kityhello.xiaoming
ps aux | rg -i "node .*bot\\.js|lark-cli event consume"
```

## 自动定时播报

当前自动播报使用 macOS LaunchAgent：

```text
/Users/kityhello/Library/LaunchAgents/com.kityhello.xiaoming-feishu-broadcast.plist
```

它每 5 分钟执行一次：

```bash
/usr/local/bin/python3 -u /Users/kityhello/workplace/geren/xiaoming/scripts/daily_broadcast.py due --config /Users/kityhello/workplace/geren/xiaoming/config/xiaoming-broadcast.example.json --send
```

日志位置：

```text
/Users/kityhello/Library/Logs/xiaoming/feishu-broadcast.log
/Users/kityhello/Library/Logs/xiaoming/feishu-broadcast-error.log
```

旧的 `com.kityhello.jump-broadcast` 已停用，后续日常播报统一发到飞书。

## 常用命令

```bash
npm run check
```

成功标志：看到 `check passed`。

```bash
npm start
```

成功标志：

- 看到 `event listener ready`
- 看到 `polling fallback ready`
- 在私聊里发新消息后，小明能回复；在群聊里只有 @ 小明后才回复。

```bash
npm run reply-latest
```

用途：对当前会话里最新一条用户消息做一次性验证。若最新消息没有 @ 小明，成功标志是日志出现 `ignored ... bot was not mentioned` 且群里不新增回复。

```bash
npm run broadcast -- countdown --config config/xiaoming-broadcast.example.json --date 2026-07-07 --now 17:30
```

用途：只生成播报预览，不发送。

```bash
npm run broadcast -- industry --config config/xiaoming-broadcast.example.json --date 2026-07-07
```

用途：生成“大道消息”预览。

```bash
npm run broadcast -- due --config config/xiaoming-broadcast.example.json --send
```

用途：发送当前时间之前尚未发送的播报到飞书。执行前必须确认 `.env` 里已有 `FEISHU_BROADCAST_CHAT_ID`。

```bash
npm test
```

用途：检查播报迁移口径和飞书发送命令，不会真实发送消息。

```bash
node bot.js --reply-text '今天北京的天气如何，会下雨吗'
node bot.js --reply-text '现在几点，今天星期几'
node bot.js --reply-text '帮我查一下 OpenAI 最新新闻'
```

用途：本地验证实时天气、时间日期和搜索工具。

## 消息处理规则

服务会同时使用两种方式：

- 事件监听：消费 `im.message.receive_v1`。
- 轮询兜底：定时读取指定会话的新消息。
- 群聊默认只有在用户 @ 小明时才回复；没有 @ 时只记录并跳过，不调用模型、不发送兜底回复。
- @ 小明可以在句首、句中或句末，也可以贴着中文写成 `配置好了@小明`；飞书结构化 `mentions` 中 `id` 可能是字符串，也可能是对象，代码需要兼容。

轮询兜底规则：

- 首次启动且没有历史状态文件时，会把最近消息标记为已读，避免对旧消息批量补发。
- 后续已处理消息 ID 持久化到 `state/xiaoming-seen.json`。
- 只有成功回复或明确忽略未 @ 消息后，才标记为已处理。
- 如果生成或发送回复失败，该消息不会永久标记为已处理，后续轮询会继续重试。

可配置项：

- `FEISHU_REQUIRE_MENTION=true`：默认开启“需要 @ 才回复”。如需临时恢复旧行为，改为 `false`。
- `FEISHU_BOT_MENTION_NAMES=小明`：群里 @ 机器人时显示的名字；如果飞书里显示成别名，用英文逗号追加，例如 `小明,机器人小明`。
- `FEISHU_BOT_OPEN_ID=`：可选。只有飞书事件提供结构化 mention ID 时才需要填写。

## 回复生成规则

1. 收到飞书用户消息。
2. 先判断是否命中实时工具。
3. 天气、时间日期、明确要求搜索或新闻类问题优先查真实数据。
4. 未命中实时工具时，把消息内容交给 Kimi。
5. 优先使用 `BOT_SYSTEM_PROMPT_FILE` 指向的文件控制小明的人设与风格。
6. 过滤模型返回中的 `<think>...</think>` 内容。
7. 按 `BOT_MAX_REPLY_CHARS` 截断过长回复。
8. 通过飞书 bot 身份回复原消息。

实时工具细节见 [realtime-tools.md](/Users/kityhello/workplace/geren/xiaoming/docs/realtime-tools.md)。

## 群聊接入

群聊不是用 webhook 实现。

正确链路：

```text
把“小明”开放平台机器人添加到目标群
→ 用户在群里 @小明
→ 本地服务收到群消息事件
→ 调用 Kimi
→ 小明在群里回复
```

需要确认：

- 小明已经被添加到目标群。
- 群里可以 @小明。
- 飞书开放平台应用权限覆盖群消息事件。
- 代码里默认只回复 @小明 的群消息。

## 播报规则

小明需要承接 `jump` 项目的日常播报能力时，先按 [broadcast-rules.md](/Users/kityhello/workplace/geren/xiaoming/docs/broadcast-rules.md) 执行。

迁移重点：

- 早安、三分钟知识卡、午间新闻、大道消息、摸鱼日历、晚间收尾是业务内容规则，可以迁移。
- 钉钉 webhook、钉钉签名、钉钉关键词不是业务规则，不迁移。
- 原 `DINGTALK_KEYWORD` 如只是消息前缀，在飞书版里改用 `message_prefix`。
- 原 `--send` 的发送目标从钉钉群改为飞书会话或飞书群。
- 手动发送“大道消息”前仍要给出完整预览，并等用户确认后再发送。

## Webhook 说明

Incoming Webhook 和开放平台机器人不是同一类能力。

- Webhook 可以往群里发消息。
- Webhook 不能读取群消息。
- Webhook 不能替代 `im.message.receive_v1` 事件监听。
- Webhook 地址属于凭证，不要写入文档、代码或公开对话。

## 故障排查

### Kimi 返回 invalid api key

优先检查：

- `KIMI_API_KEY` 是否是完整 Key。
- 是否使用 `https://api.moonshot.cn/v1`。
- `KIMI_MODEL` 是否是当前账号可调用的模型。
- Key 是否启用，账户是否已开通或充值。

### 飞书不回复

优先检查：

- `npm run check` 是否通过。
- `lark-cli whoami` 是否可用。
- 服务是否看到 `event listener ready`。
- 目标会话 ID 是否正确。
- 机器人是否有读取和回复消息的权限。

### 群聊不回复

优先检查：

- 小明是否已经添加进目标群。
- 群里是否能 @小明。
- 是否订阅了群消息事件。
- 是否只监听了私聊会话 ID。
