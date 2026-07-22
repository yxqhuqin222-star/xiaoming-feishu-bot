import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = new URL(".", import.meta.url);
loadDotenv(new URL(".env", root));

const config = {
  apiKey: process.env.KIMI_API_KEY || "",
  model: process.env.KIMI_MODEL || "kimi-k3",
  baseUrl: (process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1").replace(/\/$/, ""),
  maxTokens: Number(process.env.KIMI_MAX_TOKENS || "800"),
  systemPrompt: loadSystemPrompt(),
  maxReplyChars: Number(process.env.BOT_MAX_REPLY_CHARS || "1800"),
  requireMention: parseBoolean(process.env.FEISHU_REQUIRE_MENTION, true),
  mentionNames: parseList(process.env.FEISHU_BOT_MENTION_NAMES || "小明"),
  botOpenId: process.env.FEISHU_BOT_OPEN_ID || "",
  pollChatId: process.env.FEISHU_POLL_CHAT_ID || "",
  pollIntervalMs: Number(process.env.FEISHU_POLL_INTERVAL_MS || "5000"),
  realtimeToolsEnabled: parseBoolean(process.env.REALTIME_TOOLS_ENABLED, true),
  defaultCity: process.env.REALTIME_DEFAULT_CITY || "北京",
  searchEnabled: parseBoolean(process.env.REALTIME_SEARCH_ENABLED, true),
  searchTimeoutMs: Number(process.env.REALTIME_SEARCH_TIMEOUT_MS || "20000"),
  memoryFile: process.env.BOT_MEMORY_FILE || "state/xiaoming-memory.json",
  seenFile: process.env.BOT_SEEN_FILE || "state/xiaoming-seen.json",
};

const seen = new Set();

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const selfTestIndex = process.argv.indexOf("--self-test");
  if (selfTestIndex >= 0) {
    runSelfTest();
    return;
  }
  const replyTextIndex = process.argv.indexOf("--reply-text");
  if (replyTextIndex >= 0) {
    const text = process.argv[replyTextIndex + 1] || "";
    const reply = await generateReply(text);
    console.log(reply);
    return;
  }
  if (process.argv.includes("--check")) {
    await check();
    return;
  }
  if (process.argv.includes("--reply-latest")) {
    loadSeenMessages();
    await check();
    await replyLatestUserMessage();
    return;
  }

  const hadSeenState = loadSeenMessages();
  await check();
  startEventListener();
  await startPollingFallback({ seedExisting: !hadSeenState });
}

function loadDotenv(pathUrl) {
  if (!existsSync(pathUrl)) return;
  const text = readFileSync(pathUrl, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadSystemPrompt(env = process.env) {
  const fallback = "你是一个简洁、可靠的中文助理。回答要直接、有帮助，不编造不确定信息。";
  const promptFile = env.BOT_SYSTEM_PROMPT_FILE || "";
  if (promptFile) {
    const promptUrl = promptFile.startsWith("/") ? pathToFileURL(promptFile) : new URL(promptFile, root);
    if (!existsSync(promptUrl)) {
      throw new Error(`BOT_SYSTEM_PROMPT_FILE does not exist: ${promptFile}`);
    }
    const prompt = readFileSync(promptUrl, "utf8").trim();
    if (prompt) return prompt;
  }
  return env.BOT_SYSTEM_PROMPT || fallback;
}

function resolveRootFile(path) {
  return path.startsWith("/") ? pathToFileURL(path) : new URL(path, root);
}

async function check() {
  if (!config.apiKey) {
    throw new Error("KIMI_API_KEY is missing. Copy .env.example to .env and fill it in.");
  }

  await run("lark-cli", ["whoami"]);
  console.log("check passed");
}

function startEventListener() {
  const child = spawn(
    "lark-cli",
    ["event", "consume", "im.message.receive_v1", "--as", "bot"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void handleEventLine(trimmed);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuffer += text;
    process.stderr.write(text);
    if (stderrBuffer.includes("[event] ready event_key=im.message.receive_v1")) {
      console.log("event listener ready");
    }
  });

  child.on("exit", (code, signal) => {
    console.error(`event listener exited code=${code} signal=${signal || ""}`);
    process.exit(code || 0);
  });

  process.on("SIGINT", () => {
    child.kill("SIGTERM");
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
}

async function handleEventLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    console.error(`ignored non-json event line: ${line}`);
    return;
  }

  if (event.type !== "im.message.receive_v1") return;
  await handleIncomingMessage({
    messageId: event.message_id,
    chatType: event.chat_type,
    content: event.content,
    mentions: event.mentions,
    source: "event",
  });
}

async function startPollingFallback({ seedExisting = false } = {}) {
  if (!config.pollChatId) return;
  if (seedExisting) {
    await markExistingMessagesSeen();
    saveSeenMessages();
  }
  console.log(`polling fallback ready chat_id=${config.pollChatId}`);

  setInterval(() => {
    void pollOnce().catch((error) => {
      console.error(`polling failed: ${error.message}`);
    });
  }, config.pollIntervalMs);
}

async function markExistingMessagesSeen() {
  const messages = await listRecentMessages();
  for (const message of messages) {
    if (message.message_id) seen.add(message.message_id);
  }
}

async function pollOnce() {
  const messages = await listRecentMessages();
  for (const message of messages.reverse()) {
    if (message?.sender?.sender_type !== "user") continue;
    await handleIncomingMessage({
      messageId: message.message_id,
      chatType: message.chat_type,
      content: message.content,
      mentions: message.mentions,
      source: "poll",
    });
  }
}

async function replyLatestUserMessage() {
  const messages = await listRecentMessages();
  const message = messages.find((item) => item?.sender?.sender_type === "user");
  if (!message?.message_id || !message?.content) {
    throw new Error(`No user message found in chat ${config.pollChatId}`);
  }
  await handleIncomingMessage({
    messageId: message.message_id,
    chatType: message.chat_type,
    content: message.content,
    mentions: message.mentions,
    source: "manual",
  });
}

async function listRecentMessages() {
  const stdout = await run("lark-cli", [
    "im",
    "+chat-messages-list",
    "--chat-id",
    config.pollChatId,
    "--page-size",
    "10",
    "--as",
    "user",
  ]);
  const envelope = JSON.parse(stdout);
  return envelope?.data?.messages || [];
}

async function handleIncomingMessage({ messageId, chatType, content, mentions, source }) {
  if (!messageId || !content) return;
  if (seen.has(messageId)) return;
  seen.add(messageId);

  console.log(`received ${source} message ${messageId}: ${content}`);

  if (shouldIgnoreWithoutMention({ chatType, content, mentions })) {
    console.log(`ignored ${messageId}: bot was not mentioned`);
    saveSeenMessages();
    return;
  }

  try {
    const reply = await generateReply(content);
    await replyToMessage(messageId, reply);
    saveSeenMessages();
    console.log(`replied to ${messageId}`);
  } catch (error) {
    console.error(`failed to handle ${messageId}: ${error.message}`);
    try {
      await replyToMessage(messageId, "我暂时无法生成回复，请稍后再试。");
      saveSeenMessages();
    } catch (replyError) {
      console.error(`failed to send fallback reply: ${replyError.message}`);
      seen.delete(messageId);
    }
  }
}

function loadSeenMessages(seenFile = config.seenFile) {
  const seenUrl = resolveRootFile(seenFile);
  if (!existsSync(seenUrl)) return false;
  try {
    const parsed = JSON.parse(readFileSync(seenUrl, "utf8"));
    const ids = Array.isArray(parsed.messageIds) ? parsed.messageIds : [];
    for (const id of ids) {
      if (typeof id === "string" && id) seen.add(id);
    }
    return true;
  } catch {
    return false;
  }
}

function saveSeenMessages(seenFile = config.seenFile) {
  const seenUrl = resolveRootFile(seenFile);
  mkdirSync(new URL(".", seenUrl), { recursive: true });
  const messageIds = Array.from(seen).slice(-500);
  writeFileSync(
    seenUrl,
    `${JSON.stringify({ updatedAt: formatBeijingTimestamp(), messageIds }, null, 2)}\n`,
    "utf8",
  );
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parseList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldIgnoreWithoutMention({ chatType, content, mentions }) {
  if (!config.requireMention) return false;
  if (chatType === "p2p") return false;
  return !hasBotMention({ content, mentions });
}

function hasBotMention({ content, mentions }) {
  if (Array.isArray(mentions) && mentions.some(isBotMention)) return true;
  const text = extractMessageText(content);
  return config.mentionNames.some((name) => {
    const escaped = escapeRegExp(name);
    return new RegExp(`[@＠]\\s*${escaped}`, "i").test(text);
  });
}

function isBotMention(mention) {
  if (!mention || typeof mention !== "object") return false;
  const mentionId =
    (typeof mention.id === "object" ? mention.id?.open_id : mention.id) ||
    mention.open_id ||
    mention.user_id ||
    "";
  const mentionName = mention.name || mention.text || mention.key || "";
  return (
    Boolean(config.botOpenId && mentionId === config.botOpenId) ||
    config.mentionNames.some((name) => mentionName.includes(name))
  );
}

function extractMessageText(content) {
  if (typeof content !== "string") return "";
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.text || parsed.content || trimmed;
  } catch {
    return trimmed;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function generateReply(content) {
  const userText = extractMessageText(content);
  const memoryReply = handleMemoryCommand(userText);
  if (memoryReply) return trimReply(memoryReply, config.maxReplyChars);

  const realtimeReply = await generateRealtimeReply(userText);
  if (realtimeReply) return trimReply(realtimeReply, config.maxReplyChars);

  const relevantMemories = findRelevantMemories(userText, 5);
  const systemPrompt = buildSystemPrompt(config.systemPrompt, relevantMemories);

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText || content },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.base_resp?.status_msg || response.statusText;
    throw new Error(`Kimi request failed: ${message}`);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== "string") {
    throw new Error("Kimi response did not contain choices[0].message.content");
  }

  return trimReply(stripThinking(text), config.maxReplyChars);
}

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function trimReply(text, maxChars) {
  const normalized = text.trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 8).trimEnd()}\n...`;
}

function handleMemoryCommand(text) {
  const normalized = normalizeQuestion(text);
  if (!normalized) return null;

  const store = loadMemoryStore();
  const pendingDecision = parsePendingMemoryDecision(normalized);
  if (pendingDecision && store.pending) {
    if (pendingDecision === "confirm") {
      const saved = addMemory(store, store.pending.text, store.pending.source || "confirmed");
      store.pending = null;
      saveMemoryStore(store);
      return `记住了：${saved.text}`;
    }
    store.pending = null;
    saveMemoryStore(store);
    return "已取消，这条不会写进长期记忆。";
  }

  const rememberText = extractRememberText(normalized);
  if (rememberText) {
    const saved = addMemory(store, rememberText, "explicit");
    saveMemoryStore(store);
    return `记住了：${saved.text}`;
  }

  const forgetText = extractForgetText(normalized);
  if (forgetText !== null) {
    const removed = removeMemory(store, forgetText);
    saveMemoryStore(store);
    if (!forgetText) return "你要我忘掉什么？用“忘掉：具体内容”说清楚。";
    return removed.length
      ? `已忘掉 ${removed.length} 条相关记忆。`
      : "没找到匹配的长期记忆。";
  }

  const candidateText = extractCandidateMemoryText(normalized);
  if (candidateText) {
    store.pending = {
      id: randomUUID(),
      text: candidateText,
      source: "candidate",
      createdAt: formatBeijingTimestamp(),
    };
    saveMemoryStore(store);
    return `我理解为要长期记住：${candidateText}\n回复“确认记住”保存，回复“取消记忆”放弃。`;
  }

  return null;
}

function parsePendingMemoryDecision(text) {
  if (/^(确认记住|确认|记住吧|可以|对|是的|保存)$/.test(text)) return "confirm";
  if (/^(取消记忆|取消|不用|不要|算了|否|不是)$/.test(text)) return "cancel";
  return null;
}

function extractRememberText(text) {
  const match = text.match(/^(?:记住|记一下|记下来)[:：]\s*(.+)$/);
  return cleanMemoryText(match?.[1] || "");
}

function extractForgetText(text) {
  const match = text.match(/^(?:忘掉|忘记|删掉|删除记忆)[:：]?\s*(.*)$/);
  return match ? cleanMemoryText(match[1] || "") : null;
}

function extractCandidateMemoryText(text) {
  if (/^(以后|下次)\S+/.test(text)) return cleanMemoryText(text);
  return "";
}

function cleanMemoryText(text) {
  return String(text || "")
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadMemoryStore(memoryFile = config.memoryFile) {
  const memoryUrl = resolveRootFile(memoryFile);
  if (!existsSync(memoryUrl)) return { memories: [], pending: null };
  try {
    const parsed = JSON.parse(readFileSync(memoryUrl, "utf8"));
    return {
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      pending: parsed.pending || null,
    };
  } catch {
    return { memories: [], pending: null };
  }
}

function saveMemoryStore(store, memoryFile = config.memoryFile) {
  const memoryUrl = resolveRootFile(memoryFile);
  mkdirSync(new URL(".", memoryUrl), { recursive: true });
  writeFileSync(`${memoryUrl.pathname}.tmp`, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  rmSync(memoryUrl, { force: true });
  writeFileSync(memoryUrl, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  rmSync(`${memoryUrl.pathname}.tmp`, { force: true });
}

function addMemory(store, text, source) {
  const normalized = cleanMemoryText(text);
  const existing = store.memories.find((memory) => memory.text === normalized);
  if (existing) {
    existing.updatedAt = formatBeijingTimestamp();
    return existing;
  }
  const memory = {
    id: randomUUID(),
    text: normalized,
    source,
    createdAt: formatBeijingTimestamp(),
  };
  store.memories.unshift(memory);
  return memory;
}

function removeMemory(store, text) {
  const normalized = cleanMemoryText(text);
  if (!normalized) return [];
  const removed = [];
  store.memories = store.memories.filter((memory) => {
    const matched = memory.text.includes(normalized) || normalized.includes(memory.text);
    if (matched) removed.push(memory);
    return !matched;
  });
  return removed;
}

function findRelevantMemories(text, limit) {
  const store = loadMemoryStore();
  const queryTokens = tokenizeMemoryText(text);
  const scored = store.memories
    .map((memory) => ({
      memory,
      score: scoreMemory(memory.text, queryTokens, text),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.memory);
}

function scoreMemory(memoryText, queryTokens, originalText) {
  if (!memoryText) return 0;
  if (originalText && (memoryText.includes(originalText) || originalText.includes(memoryText))) return 20;
  const memoryTokens = tokenizeMemoryText(memoryText);
  return memoryTokens.filter((token) => queryTokens.includes(token)).length;
}

function tokenizeMemoryText(text) {
  return Array.from(
    new Set(
      String(text || "")
        .toLowerCase()
        .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, " ")
        .split(/\s+/)
        .flatMap((token) => (/[\u4e00-\u9fa5]/.test(token) && token.length >= 3 ? splitChineseToken(token) : [token]))
        .filter((token) => token.length >= 2),
    ),
  );
}

function splitChineseToken(token) {
  const chunks = [token];
  for (let index = 0; index <= token.length - 2; index += 1) {
    chunks.push(token.slice(index, index + 2));
  }
  return chunks;
}

function buildSystemPrompt(basePrompt, memories) {
  if (!memories.length) return basePrompt;
  const memoryLines = memories.map((memory, index) => `${index + 1}. ${memory.text}`).join("\n");
  return `${basePrompt}\n\n长期记忆（只在相关时参考，不能违背用户当前明确指令）：\n${memoryLines}`;
}

function formatBeijingTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}+08:00`;
}

async function generateRealtimeReply(text) {
  if (!config.realtimeToolsEnabled) return null;
  const normalized = normalizeQuestion(text);
  if (!normalized) return null;

  if (isTimeQuestion(normalized)) return formatTimeReply();
  if (isWeatherQuestion(normalized)) {
    const city = extractWeatherCity(normalized) || config.defaultCity;
    try {
      return formatWeatherReply(await fetchWeather(city), city);
    } catch (error) {
      return `${city}天气我这边实时接口没拿到，先别让我瞎编。你看一眼手机天气最稳。`;
    }
  }
  if (config.searchEnabled && isSearchQuestion(normalized)) {
    try {
      const query = cleanSearchQuery(normalized);
      return formatSearchReply(await searchWeb(query), query);
    } catch (error) {
      return `我试着联网查了，但搜索接口这次没拿到可用结果。你换个更具体的关键词，我再查一次。`;
    }
  }
  return null;
}

function normalizeQuestion(text) {
  return String(text || "")
    .replace(/<at[^>]*>.*?<\/at>/gi, "")
    .replace(/[@＠]\s*小明/g, "")
    .replace(/```[A-Za-z0-9_-]*\s*([\s\S]*?)```/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isTimeQuestion(text) {
  return /(几点|时间|日期|今天周几|今天星期几|现在几号|今天几号)/.test(text);
}

function formatTimeReply() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `现在是北京时间 ${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}，${value.weekday}。`;
}

function isWeatherQuestion(text) {
  return /(天气|气温|温度|下雨|降雨|会雨|冷不冷|热不热|要带伞|带伞)/.test(text);
}

function extractWeatherCity(text) {
  const withoutMention = text.replace(/[@＠]\s*\S+/g, "").trim();
  const patterns = [
    /(?:今天|明天|现在|当前)?\s*([\u4e00-\u9fa5]{2,10})(?:的)?(?:天气|气温|温度)/,
    /([\u4e00-\u9fa5]{2,10})(?:会不会|会)?(?:下雨|降雨)/,
    /([\u4e00-\u9fa5]{2,10})(?:要不要|需要)?带伞/,
  ];
  for (const pattern of patterns) {
    const match = withoutMention.match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/^(今天|明天|现在|当前)/, "")
        .replace(/的$/, "")
        .trim();
    }
  }
  return "";
}

async function fetchWeather(city) {
  const geocodingQuery = new URLSearchParams({
    name: city,
    count: "1",
    language: "zh",
    format: "json",
  });
  const geocoding = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?${geocodingQuery}`,
    10000,
  );
  const location = geocoding?.results?.[0];
  if (!location) throw new Error(`找不到城市：${city}`);

  const forecastQuery = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "temperature_2m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "1",
  });
  const forecast = await fetchJson(`https://api.open-meteo.com/v1/forecast?${forecastQuery}`, 10000);
  const current = forecast.current;
  const daily = forecast.daily;
  return {
    weather: weatherCodeLabel(current.weather_code),
    temperature: Math.round(current.temperature_2m),
    high: Math.round(daily.temperature_2m_max[0]),
    low: Math.round(daily.temperature_2m_min[0]),
    rain: Math.round(daily.precipitation_probability_max[0]),
  };
}

function formatWeatherReply(weather, city) {
  const rainText = weather.rain >= 50 ? "有下雨风险，带伞稳一点" : "下雨概率不高";
  return `${city}现在${weather.weather}，约 ${weather.temperature}℃，今天 ${weather.low}-${weather.high}℃，降雨概率 ${weather.rain}%。${rainText}。`;
}

function weatherCodeLabel(code) {
  const labels = {
    0: "晴",
    1: "大部晴朗",
    2: "局部多云",
    3: "阴",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "大毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷雨",
  };
  return labels[code] || "天气状况未知";
}

function isSearchQuestion(text) {
  if (isWeatherQuestion(text) || isTimeQuestion(text)) return false;
  return /(查一下|搜一下|搜索|联网查|帮我查|新闻|热搜|资讯|今天.*(发生|消息|资讯)|现在.*(情况|价格|进展)|最新.{0,12}(新闻|消息|资讯|报道|进展|情况|价格|动态))/.test(text);
}

function cleanSearchQuery(text) {
  let query = String(text || "")
    .replace(/<at[^>]*>.*?<\/at>/gi, "")
    .replace(/[@＠]\s*小明/g, "")
    .trim()
    .replace(/^(小明|帮我|你帮我|麻烦你|请你|帮忙)?\s*(查一下|搜一下|搜索一下|搜索|联网查一下|联网查|查查|查)\s*/g, "")
    .replace(/^(你现在|现在|今天)?\s*(播报|说一下|讲一下|整理一下|列一下)\s*/g, "")
    .replace(/^(\d+\s*条)?\s*/, "")
    .replace(/[？?。！!]+$/g, "")
    .trim();
  if (/^(热搜|新闻|热点)$/.test(query)) query = `今天 ${query}`;
  return query || text;
}

async function searchWeb(query) {
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const html = await fetchText(searchUrl, config.searchTimeoutMs);
  const results = parseBingHtml(html).slice(0, 2);
  if (!results.length) throw new Error("搜索接口没有返回可用结果。");
  return results;
}

function parseBingHtml(html) {
  const results = [];
  const pattern = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)(?=<li class="b_algo"|<li class="b_pag"|<\/ol>)/gi;
  let match;
  while ((match = pattern.exec(String(html || ""))) !== null) {
    const url = decodeHtml(match[1]);
    const title = stripHtml(match[2]);
    const snippetMatch = match[3].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripHtml(snippetMatch?.[1] || "");
    if (!title || !url.startsWith("http")) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  return stripHtml(text);
}

function formatSearchReply(results, query) {
  const lines = [`我查了一下「${query}」：`];
  for (const [index, result] of results.entries()) {
    const snippet = result.snippet ? `：${truncateText(result.snippet, 42)}` : "";
    lines.push(`${index + 1}. ${truncateText(result.title, 34)}${snippet}`);
    lines.push(result.url);
  }
  return lines.join("\n");
}

function truncateText(text, maxLength) {
  const normalized = String(text || "").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 xiaoming-feishu-bot/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { "User-Agent": "xiaoming-feishu-bot/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function replyToMessage(messageId, text) {
  const idempotencyKey = `feishu-kimi-${messageId}`;
  await run("lark-cli", [
    "im",
    "+messages-reply",
    "--message-id",
    messageId,
    "--text",
    text,
    "--as",
    "bot",
    "--idempotency-key",
    idempotencyKey,
  ]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
      }
    });
  });
}

function runSelfTest() {
  const oldMemoryFile = config.memoryFile;
  const oldSeenFile = config.seenFile;
  const oldSeen = new Set(seen);
  const tempDir = mkdtempSync(`${tmpdir()}/xiaoming-memory-test-`);
  config.memoryFile = `${tempDir}/memory.json`;
  config.seenFile = `${tempDir}/seen.json`;
  seen.clear();
  const hadSeenBeforeSave = loadSeenMessages();
  seen.add("om_seen_test");
  saveSeenMessages();
  seen.clear();
  const hadSeenAfterSave = loadSeenMessages();
  const mentionAtEnd = hasBotMention({
    content: "我刚才已经更新你的个性化配置了@小明",
    mentions: [{ id: "ou_test", key: "@_user_1", name: "小明" }],
  });
  const mentionAttachedToText = hasBotMention({
    content: "我刚才已经更新你的个性化配置了 用最新的要求进行回复@小明",
    mentions: [],
  });
  const cleanedSearch = cleanSearchQuery("@小明 你现在播报10条今天的新闻");
  const promptFromFile = loadSystemPrompt({
    BOT_SYSTEM_PROMPT_FILE: "config/xiaoming-system-prompt.md",
    BOT_SYSTEM_PROMPT: "fallback prompt",
  });
  const shouldSearchLatestNews = isSearchQuestion("帮我查一下 OpenAI 最新新闻");
  const shouldSearchLatestTopicNews = isSearchQuestion("最新 AI 消息");
  const shouldNotSearchLatestRequirement = isSearchQuestion("你现在的回复是根据最新的要求吗");
  const directMemoryReply = handleMemoryCommand("记住：我不喜欢空话");
  const directMemoryStore = loadMemoryStore();
  const candidateMemoryReply = handleMemoryCommand("以后回答前先给结论");
  const confirmMemoryReply = handleMemoryCommand("确认记住");
  const codeBlockCandidateReply = handleMemoryCommand("```PLAIN_TEXT\n以后回答尽量短一点\n```");
  const cancelCodeBlockCandidateReply = handleMemoryCommand("取消记忆");
  const relevantMemories = findRelevantMemories("回答要先给结论，不要空话", 5);
  const forgetMemoryReply = handleMemoryCommand("忘掉：空话");
  const failures = [];
  if (hadSeenBeforeSave) failures.push("missing seen file should return false");
  if (!hadSeenAfterSave || !seen.has("om_seen_test")) {
    failures.push("seen message state was not persisted");
  }
  if (!mentionAtEnd) failures.push("mention at end was not detected");
  if (!mentionAttachedToText) failures.push("mention attached to text was not detected");
  if (cleanedSearch !== "今天的新闻") failures.push(`unexpected cleaned query: ${cleanedSearch}`);
  if (!promptFromFile.includes("清醒、温柔、靠谱")) failures.push("system prompt file was not loaded");
  if (!shouldSearchLatestNews) failures.push("latest news should trigger search");
  if (!shouldSearchLatestTopicNews) failures.push("latest topic news should trigger search");
  if (shouldNotSearchLatestRequirement) failures.push("latest requirement should not trigger search");
  if (!directMemoryReply.includes("记住了")) failures.push("direct memory was not saved");
  if (!/\+08:00$/.test(directMemoryStore.memories[0]?.createdAt || "")) {
    failures.push("memory timestamp should use Beijing timezone");
  }
  if (!candidateMemoryReply.includes("确认记住")) failures.push("candidate memory did not ask for confirmation");
  if (!confirmMemoryReply.includes("记住了")) failures.push("candidate memory was not confirmed");
  if (!codeBlockCandidateReply.includes("确认记住")) {
    failures.push("code block candidate memory did not ask for confirmation");
  }
  if (!cancelCodeBlockCandidateReply.includes("已取消")) {
    failures.push("code block candidate memory was not cancelled");
  }
  if (relevantMemories.length > 5) failures.push("too many relevant memories returned");
  if (!relevantMemories.some((memory) => memory.text.includes("先给结论"))) {
    failures.push("confirmed memory was not retrieved");
  }
  if (!forgetMemoryReply.includes("已忘掉")) failures.push("forget command did not remove memory");
  config.memoryFile = oldMemoryFile;
  config.seenFile = oldSeenFile;
  seen.clear();
  for (const id of oldSeen) seen.add(id);
  rmSync(tempDir, { recursive: true, force: true });
  if (failures.length) throw new Error(failures.join("; "));
  console.log("self-test passed");
}
