# 小明飞书机器人

小明是一个本地运行的飞书机器人，用于在飞书私聊和群聊里回复消息，并承接早安、知识卡、大道消息、摸鱼日历、晚间收尾等日常播报能力。

## 能力概览

- 私聊直接回复用户消息。
- 群聊默认只有被 `@小明` 时才回复。
- 通过飞书开放平台机器人身份回复原消息。
- 使用 Kimi 生成普通聊天回复。
- 天气、时间日期、搜索和新闻类问题优先走实时查询。
- 使用事件监听加轮询兜底，避免飞书事件偶发丢失。
- 已处理消息 ID 持久化到 `state/xiaoming-seen.json`，短暂失败后可重试，重启后不重复回复。
- 支持 macOS LaunchAgent 常驻运行。

## 目录结构

```text
bot.js                              # 飞书监听、轮询、回复生成和消息回复入口
package.json                        # npm 命令
config/
  com.kityhello.xiaoming.plist      # macOS 常驻服务配置模板
  xiaoming-system-prompt.md         # 小明系统提示词
  xiaoming-broadcast.example.json   # 播报配置示例
data/                               # 播报和知识内容数据
docs/                               # 项目文档、运行手册、播报规则
scripts/                            # 播报、飞书发送、库存维护脚本
tests/                              # Python 单元测试
```

## 运行依赖

- Node.js >= 20
- Python 3
- `lark-cli`
- Kimi API Key
- 已配置并可读取消息、回复消息的飞书开放平台机器人

## 本地配置

复制环境变量模板：

```bash
cp .env.example .env
```

至少填写：

```bash
KIMI_API_KEY=你的 Kimi API Key
FEISHU_POLL_CHAT_ID=飞书会话 ID
```

常用配置：

```bash
KIMI_MODEL=kimi-k3
KIMI_BASE_URL=https://api.moonshot.cn/v1
BOT_SYSTEM_PROMPT_FILE=config/xiaoming-system-prompt.md
BOT_MAX_REPLY_CHARS=260

FEISHU_REQUIRE_MENTION=true
FEISHU_BOT_MENTION_NAMES=小明
FEISHU_POLL_INTERVAL_MS=5000

REALTIME_TOOLS_ENABLED=true
REALTIME_DEFAULT_CITY=北京
REALTIME_SEARCH_ENABLED=true
```

不要提交真实 `.env`。仓库的 `.gitignore` 已排除 `.env`、`state/`、缓存和系统文件。

## 常用命令

检查配置和飞书 CLI 状态：

```bash
npm run check
```

本地前台启动：

```bash
npm start
```

一次性处理当前会话最新用户消息：

```bash
npm run reply-latest
```

运行测试：

```bash
npm test
node bot.js --self-test
```

实时能力本地验证：

```bash
node bot.js --reply-text '今天北京的天气如何，会下雨吗'
node bot.js --reply-text '现在几点，今天星期几'
node bot.js --reply-text '帮我查一下 OpenAI 最新新闻'
```

## macOS 常驻服务

项目内保存了 LaunchAgent 模板：

```text
config/com.kityhello.xiaoming.plist
```

安装到当前用户：

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/xiaoming
cp config/com.kityhello.xiaoming.plist ~/Library/LaunchAgents/com.kityhello.xiaoming.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kityhello.xiaoming.plist
launchctl enable gui/$(id -u)/com.kityhello.xiaoming
launchctl kickstart -k gui/$(id -u)/com.kityhello.xiaoming
```

查看状态：

```bash
launchctl print gui/$(id -u)/com.kityhello.xiaoming
```

日志位置：

```text
~/Library/Logs/xiaoming/feishu-listener.log
~/Library/Logs/xiaoming/feishu-listener-error.log
```

成功标志：

- `check passed`
- `event listener ready`
- `polling fallback ready chat_id=...`

## 飞书 CLI 凭证

后台 LaunchAgent 需要能读取 `lark-cli` 凭证。若日志里反复出现 `keychain access blocked`，可以在普通 Terminal 里执行：

```bash
lark-cli config keychain-downgrade
```

这会把 `lark-cli` 的主密钥从 macOS Keychain 复制到本地文件，提升后台稳定性，但安全性弱于 Keychain。

## 故障排查

小明不回复时先查：

```bash
launchctl print gui/$(id -u)/com.kityhello.xiaoming
ps aux | rg -i "node .*bot\\.js|lark-cli event consume"
tail -120 ~/Library/Logs/xiaoming/feishu-listener.log
tail -120 ~/Library/Logs/xiaoming/feishu-listener-error.log
lark-cli whoami
```

常见原因：

- LaunchAgent 没运行。
- `lark-cli` token 过期或无法刷新。
- 飞书事件 websocket 断开，等待自动重连或靠轮询兜底。
- 群聊消息没有真正 `@小明`。
- Kimi API Key 无效或模型不可用。

## 更多文档

- [项目文档](docs/PROJECT.md)
- [运行手册](docs/feishu-bot-runbook.md)
- [小明人设](docs/xiaoming-profile.md)
- [实时查询能力](docs/realtime-tools.md)
- [播报规则](docs/broadcast-rules.md)
