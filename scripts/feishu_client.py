#!/usr/bin/env python3
import json
import os
import subprocess
from pathlib import Path


def load_local_env():
    base_dir = Path(__file__).resolve().parents[1]
    for path in (base_dir / ".env.local", base_dir / ".env"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_local_env()


def send_feishu_message(message, chat_id=None):
    target_chat_id = chat_id or os.environ.get("FEISHU_BROADCAST_CHAT_ID")
    if not target_chat_id:
        raise RuntimeError("Missing FEISHU_BROADCAST_CHAT_ID environment variable.")

    command = [
        "lark-cli",
        "im",
        "+messages-send",
        "--chat-id",
        target_chat_id,
        "--text",
        message,
        "--as",
        "bot",
    ]
    result = subprocess.run(
        command,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "lark-cli send failed")
    return message, json.loads(result.stdout or "{}")
