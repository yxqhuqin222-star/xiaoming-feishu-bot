import json
import os
import sys
import unittest
from datetime import date, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from daily_broadcast import (  # noqa: E402
    BroadcastConfig,
    build_broadcast,
    load_config,
    prepare_industry_news,
    url_content_id,
)
from feishu_client import send_feishu_message  # noqa: E402


class BroadcastMigrationTest(unittest.TestCase):
    def test_config_splits_prefix_and_names(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "message_prefix": "小明",
                        "recipient_name": "阿琴",
                        "closing_name": "琴",
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            config = load_config(path)

        self.assertEqual("小明", config.message_prefix)
        self.assertEqual("阿琴", config.recipient_name)
        self.assertEqual("琴", config.closing_name)

    def test_morning_uses_recipient_name_not_prefix(self):
        config = BroadcastConfig(
            message_prefix="小明",
            recipient_name="阿琴",
            weather="晴，12-22 度",
        )

        broadcast = build_broadcast("morning", config, date(2026, 7, 7))

        self.assertIn("小明｜早安，阿琴。", broadcast.message)
        self.assertNotIn("早安，小明", broadcast.message)

    def test_countdown_keeps_five_modules(self):
        broadcast = build_broadcast(
            "countdown",
            BroadcastConfig(message_prefix="小明"),
            date(2026, 7, 7),
            now_time=datetime(2026, 7, 7, 17, 30).time(),
        )

        for module in ("情绪温度", "办公室观察题", "一分钟放空", "今日小问题", "下班通行证"):
            self.assertIn(f"{module}：", broadcast.message)
        self.assertIn("小明｜摸鱼日历。", broadcast.message)

    def test_industry_jike_format_uses_required_fields(self):
        config = BroadcastConfig(
            message_prefix="小明",
            industry_news=[
                {
                    "author": "作者",
                    "published_at": "刚刚",
                    "content": "正文",
                    "url": "https://web.okjike.com/originalPosts/real-test",
                }
            ],
        )

        broadcast = build_broadcast("industry", config, date(2026, 7, 7))

        self.assertIn("小明｜大道消息｜即刻精选。", broadcast.message)
        self.assertIn("1. [作者｜刚刚] 正文", broadcast.message)
        self.assertIn("原文：https://web.okjike.com/originalPosts/real-test", broadcast.message)

    def test_example_config_does_not_include_industry_news(self):
        config = load_config(ROOT / "config" / "xiaoming-broadcast.example.json")

        self.assertEqual([], config.industry_news)

    def test_placeholder_jike_news_falls_back_to_owen(self):
        config = BroadcastConfig(
            industry_news=[
                {
                    "author": "示例作者",
                    "published_at": "刚刚",
                    "content": "示例正文",
                    "url": "https://web.okjike.com/originalPosts/example-1",
                }
            ],
        )
        owen_news = [{"title": "真实资讯", "url": "https://example.org/real"}]

        with patch("daily_broadcast.load_sent_news_ids", return_value=set()), patch(
            "daily_broadcast.fetch_owen_links", return_value=owen_news
        ):
            prepare_industry_news(config)

        self.assertEqual("owen", config.industry_source)
        self.assertEqual(owen_news, config.industry_news)

    def test_owen_skips_urls_from_global_history(self):
        old_url = "https://en.wikipedia.org/wiki/Small_penis_rule"
        config = BroadcastConfig(
            industry_source="owen",
            sent_content_ids={url_content_id(old_url)},
        )

        with patch("daily_broadcast.load_sent_news_ids", return_value=set()), patch(
            "daily_broadcast.fetch_owen_links", return_value=[]
        ) as fetch:
            prepare_industry_news(config)

        self.assertIn(old_url, fetch.call_args.args[0])

    def test_countdown_skips_content_from_global_history(self):
        first = build_broadcast(
            "countdown",
            BroadcastConfig(message_prefix="小明"),
            date(2026, 7, 7),
            now_time=datetime(2026, 7, 7, 17, 30).time(),
        )
        config = BroadcastConfig(
            message_prefix="小明",
            sent_content_ids=set(first.context["content_ids"]),
        )

        second = build_broadcast(
            "countdown",
            config,
            date(2026, 7, 8),
            now_time=datetime(2026, 7, 8, 17, 30).time(),
        )

        self.assertTrue(first.context["content_ids"].isdisjoint(second.context["content_ids"]))
        self.assertNotEqual(first.message, second.message)


class FeishuClientTest(unittest.TestCase):
    def test_send_feishu_message_uses_lark_cli_bot_identity(self):
        completed = Mock(returncode=0, stdout='{"ok": true}', stderr="")

        with patch.dict(os.environ, {"FEISHU_BROADCAST_CHAT_ID": "oc_test"}, clear=False), patch(
            "feishu_client.subprocess.run",
            return_value=completed,
        ) as run:
            message, response = send_feishu_message("测试消息")

        self.assertEqual("测试消息", message)
        self.assertEqual({"ok": True}, response)
        command = run.call_args.args[0]
        self.assertEqual(
            [
                "lark-cli",
                "im",
                "+messages-send",
                "--chat-id",
                "oc_test",
                "--text",
                "测试消息",
                "--as",
                "bot",
            ],
            command,
        )


if __name__ == "__main__":
    unittest.main()
