"""Decision-QA command-line client."""

from pathlib import Path

SCHEMA = 1


def cli_version() -> str:
    try:
        return (Path(__file__).resolve().parents[2] / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "dev"
