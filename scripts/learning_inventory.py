import json
import re
import ssl
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path

import certifi


INVENTORY_TARGET = 30
INVENTORY_MINIMUM = 10
REFRESH_INTERVAL = timedelta(hours=6)
SUMMARY_MIN_LENGTH = 40
SUMMARY_MAX_LENGTH = 180
HN_ARTICLE_SUMMARY_LIMIT = 2
BUZZING_HN_FEED_URL = "https://hn.buzzing.cc/feed.json"
SUMMARY_NOISE_MARKERS = (
    "供图",
    "图源",
    "■本报记者",
    "文｜",
    "文|",
    "编译|",
)
HACKER_NEWS_SOURCE_PREFIX = "Hacker News"
CATEGORY_KEYWORDS = (
    ("健康", ("医疗", "健康", "医院", "疾病", "药物", "养老", "生物医药")),
    ("科学", ("科学", "科研", "研究", "实验", "论文", "核聚变", "天文")),
    (
        "科技",
        (
            "AI",
            "人工智能",
            "芯片",
            "机器人",
            "手机",
            "软件",
            "汽车",
            "电池",
            "互联网",
            "数据中心",
            "鸿蒙",
            "iPhone",
            "Apple",
            "智能",
        ),
    ),
    ("生活", ("生活", "家居", "客厅", "租房", "电影", "游戏", "阅读")),
)
QUALITY_FEEDS = ()
CURRENT_DYNAMIC_SOURCES = {
    "Hacker News 热门",
    *(source for source, _category, _url in QUALITY_FEEDS),
}


class _TextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


class _MetaDescriptionParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.description = ""

    def handle_starttag(self, tag, attrs):
        if self.description or tag.lower() != "meta":
            return
        values = {key.lower(): value for key, value in attrs if key and value}
        name = values.get("name", "").lower()
        prop = values.get("property", "").lower()
        if name in {"description", "twitter:description"} or prop in {
            "og:description",
            "twitter:description",
        }:
            self.description = values.get("content", "").strip()


def _html_to_text(value):
    parser = _TextParser()
    parser.feed(value or "")
    return " ".join("".join(parser.parts).split())


def _clean_summary(value):
    value = _html_to_text(value)
    value = value.split("#欢迎关注", 1)[0].rstrip()
    value = re.sub(
        r"^作者\s*\|\s*\S+\s+编辑\s*\|\s*\S+\s*",
        "",
        value,
    )
    for suffix in ("查看全文", "阅读原文"):
        if suffix in value:
            value = value.split(suffix, 1)[0].rstrip("。；;，, ")
    value = re.sub(
        r"\s*-\s*(?:by|Directed by|Video by)\s+.+?(?:Read on|Watch on)\s+\S+\s*$",
        "",
        value,
    )
    if value.endswith(("...", "…")):
        shortened = value.rstrip(".… ")
        boundary = max(
            shortened.rfind(mark)
            for mark in ("。", "！", "？", "；")
        )
        value = shortened[: boundary + 1] if boundary >= SUMMARY_MIN_LENGTH else ""
    if len(value) > SUMMARY_MAX_LENGTH:
        shortened = value[: SUMMARY_MAX_LENGTH + 1]
        boundary = max(
            shortened.rfind(mark)
            for mark in ("。", "！", "？", "；", ".", "!", "?", ";")
        )
        value = shortened[: boundary + 1] if boundary >= SUMMARY_MIN_LENGTH else ""
    value = re.sub(r"^■\S+\s+", "", value)
    return value.lstrip("·.• \t").strip()


def _extract_hacker_news_metrics(value):
    points = re.search(r"(?:Points|HN Points):\s*([\d,]+)", value or "")
    if not points:
        points = re.search(r"([\d,]+)\s+HN Points", value or "")
    comments = re.search(r"#\s*Comments:\s*([\d,]+)", value or "")
    return (
        points.group(1) if points else "",
        comments.group(1) if comments else "",
    )


def _extract_hacker_news_url(value):
    match = re.search(r"https://news\.ycombinator\.com/item\?id=\d+", value or "")
    return match.group(0) if match else ""


def _hacker_news_summary(title, feed_summary, article_summary=""):
    points, comments = _extract_hacker_news_metrics(feed_summary)
    article_summary = _clean_summary(article_summary)
    heat_parts = []
    if points:
        heat_parts.append(f"{points} 分")
    if comments:
        heat_parts.append(f"{comments} 条讨论")
    heat = "，".join(heat_parts)
    if article_summary:
        suffix = f" HN 热度：{heat}。" if heat else ""
        return _clean_summary(f"{article_summary}{suffix}")
    if heat:
        return (
            f"Hacker News 高分讨论：这篇文章围绕“{title}”引发技术社区关注，"
            f"目前约 {heat}，适合从原文和评论区快速了解核心争议。"
        )
    return (
        f"Hacker News 推荐内容：这篇文章围绕“{title}”展开，"
        "适合作为技术趋势、工具或工程实践的知识卡选题。"
    )


def _extract_meta_description(html):
    parser = _MetaDescriptionParser()
    parser.feed(html or "")
    return parser.description


def _fetch_article_summary(url, context):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "xiaoming-feishu-broadcast/1.0"},
    )
    with urllib.request.urlopen(request, timeout=2, context=context) as response:
        content_type = response.headers.get("Content-Type", "")
        if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
            return ""
        html = response.read(400_000).decode("utf-8", errors="ignore")
    return _extract_meta_description(html)


def _parse_buzzing_published_day(value):
    if not value:
        return ""
    return value.split("T", 1)[0]


def parse_buzzing_hn_feed(payload, limit=10):
    data = json.loads(payload.decode("utf-8") if isinstance(payload, bytes) else payload)
    items = data.get("items", [])
    if not items:
        return []
    latest_day = _parse_buzzing_published_day(items[0].get("date_published", ""))
    result = []
    for item in items:
        published_at = item.get("date_published", "")
        if latest_day and _parse_buzzing_published_day(published_at) != latest_day:
            continue
        content = item.get("content_text", "")
        points, _comments = _extract_hacker_news_metrics(content)
        hn_url = _extract_hacker_news_url(content)
        title = _html_to_text(item.get("title", ""))
        summary = _html_to_text(item.get("summary", ""))
        url = _clean_url(item.get("url", ""))
        if not title or not summary or not url:
            continue
        heat = f"HN {points} 分" if points else "Hacker News 热门"
        result.append(
            {
                "source": "Hacker News 热门",
                "default_category": "科技",
                "title": title,
                "summary": f"{summary}。{heat}。",
                "published_at": published_at,
                "url": url,
                "discussion_url": hn_url,
            }
        )
        if len(result) >= limit:
            break
    return result


def _category_for_item(item):
    text = f"{item['title']} {item['summary']}"
    for category, keywords in CATEGORY_KEYWORDS:
        if any(keyword in text for keyword in keywords):
            return category
    return item["default_category"]


def _clean_url(value):
    parsed = urllib.parse.urlsplit(value.strip())
    query = [
        (key, item)
        for key, item in urllib.parse.parse_qsl(
            parsed.query,
            keep_blank_values=True,
        )
        if not key.startswith("utm_") and key not in {"f", "from"}
    ]
    return urllib.parse.urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            urllib.parse.urlencode(query),
            "",
        )
    )


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _child_text(element, *names):
    for child in element:
        if _local_name(child.tag) in names:
            return "".join(child.itertext()).strip()
    return ""


def parse_feed(
    xml,
    source,
    default_category,
    summary_resolver=None,
    summary_resolver_limit=HN_ARTICLE_SUMMARY_LIMIT,
):
    root = ET.fromstring(xml)
    result = []
    resolved_summaries = 0
    for entry in root.iter():
        if _local_name(entry.tag) not in ("item", "entry"):
            continue
        link = _child_text(entry, "link")
        if not link:
            link_node = next(
                (
                    child
                    for child in entry
                    if _local_name(child.tag) == "link" and child.get("href")
                ),
                None,
            )
            link = link_node.get("href", "") if link_node is not None else ""
        raw_summary = _child_text(entry, "description", "summary", "content")
        summary = _clean_summary(raw_summary)
        if source.startswith(HACKER_NEWS_SOURCE_PREFIX):
            article_summary = ""
            if (
                summary_resolver
                and link
                and resolved_summaries < summary_resolver_limit
            ):
                resolved_summaries += 1
                try:
                    article_summary = summary_resolver(_clean_url(link))
                except OSError:
                    article_summary = ""
            summary = _hacker_news_summary(
                _html_to_text(_child_text(entry, "title")),
                raw_summary,
                article_summary,
            )
        item = {
            "source": source,
            "default_category": default_category,
            "title": _html_to_text(_child_text(entry, "title")),
            "summary": summary,
            "published_at": _html_to_text(
                _child_text(entry, "pubDate", "published", "updated")
            ),
            "url": _clean_url(link),
        }
        if (
            item["title"]
            and SUMMARY_MIN_LENGTH <= len(item["summary"]) <= SUMMARY_MAX_LENGTH
            and not any(
                marker in item["summary"]
                for marker in SUMMARY_NOISE_MARKERS
            )
            and item["url"]
        ):
            result.append(item)
    return result


def fetch_feed_candidates(feeds=QUALITY_FEEDS):
    context = ssl.create_default_context(cafile=certifi.where())
    candidates = []
    request = urllib.request.Request(
        BUZZING_HN_FEED_URL,
        headers={"User-Agent": "xiaoming-feishu-broadcast/1.0"},
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=20,
            context=context,
        ) as response:
            candidates.extend(parse_buzzing_hn_feed(response.read()))
    except (OSError, json.JSONDecodeError):
        pass
    source_items = []
    for source, category, url in feeds:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "xiaoming-feishu-broadcast/1.0"},
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=20,
                context=context,
            ) as response:
                resolver = (
                    (lambda url: _fetch_article_summary(url, context))
                    if source.startswith(HACKER_NEWS_SOURCE_PREFIX)
                    else None
                )
                source_items.append(
                    parse_feed(response.read(), source, category, resolver)
                )
        except (OSError, ET.ParseError):
            continue
    for index in range(max((len(items) for items in source_items), default=0)):
        for items in source_items:
            if index < len(items):
                candidates.append(items[index])
    return candidates


def load_inventory(path):
    path = Path(path)
    if not path.exists():
        return {
            "cards": [],
            "sent_urls": [],
            "last_category": "",
            "last_refresh_at": "",
            "last_error": "",
        }
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("cards", [])
    data.setdefault("sent_urls", [])
    data.setdefault("last_category", "")
    data.setdefault("last_refresh_at", "")
    data.setdefault("last_error", "")
    return data


def save_inventory(path, inventory):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def refresh_inventory(path, force=False, target=INVENTORY_TARGET):
    inventory = load_inventory(path)
    inventory["cards"] = [
        card
        for card in inventory["cards"]
        if card.get("source") in CURRENT_DYNAMIC_SOURCES
    ]
    if len(inventory["cards"]) >= target:
        save_inventory(path, inventory)
        return inventory
    if not force and inventory["last_refresh_at"]:
        last_refresh = datetime.fromisoformat(inventory["last_refresh_at"])
        if datetime.now() - last_refresh < REFRESH_INTERVAL:
            return inventory
    inventory["last_refresh_at"] = datetime.now().isoformat(timespec="seconds")
    known_urls = {
        *inventory["sent_urls"],
        *(card["source_url"] for card in inventory["cards"]),
    }
    candidates = [
        item
        for item in fetch_feed_candidates()
        if item["url"] not in known_urls
    ]
    needed = target - len(inventory["cards"])
    inventory["cards"].extend(
        {
            "category": _category_for_item(item),
            "title": item["title"],
            "summary": item["summary"],
            "source": item["source"],
            "source_url": item["url"],
            "discussion_url": item.get("discussion_url", ""),
            "published_at": item["published_at"],
        }
        for item in candidates[:needed]
    )
    inventory["last_error"] = ""
    save_inventory(path, inventory)
    return inventory


def select_card(inventory):
    last_category = inventory.get("last_category", "")
    counts = Counter(
        card["category"]
        for card in inventory.get("cards", [])
        if card["category"] != last_category
    )
    if not counts:
        counts = Counter(card["category"] for card in inventory.get("cards", []))
    if not counts:
        return None
    category = counts.most_common(1)[0][0]
    return next(
        (
            card
            for card in inventory.get("cards", [])
            if card["category"] == category
        ),
        None,
    )


def mark_card_sent(inventory, card):
    inventory["cards"] = [
        item
        for item in inventory["cards"]
        if item["source_url"] != card["source_url"]
    ]
    inventory["sent_urls"] = sorted(
        {*inventory["sent_urls"], card["source_url"]}
    )
    inventory["last_category"] = card["category"]
    return inventory
