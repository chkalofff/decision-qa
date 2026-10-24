#!/usr/bin/env python3
"""Управление Bearer-токенами Decision-QA (сырой токен печатается один раз)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import auth


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, default=None,
                        help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="создать токен для owner")
    create.add_argument("owner", help="id владельца: A–Z/a–z/0–9/_/-")
    sub.add_parser("list", help="показать метаданные токенов без секретов")
    revoke = sub.add_parser("revoke", help="отозвать активный токен по prefix")
    revoke.add_argument("prefix")
    args = parser.parse_args()

    try:
        if args.command == "create":
            token, record = auth.create_token(args.owner, args.file)
            print(token)
            print(f"owner={record['owner']} prefix={record['prefix']} — сохраните токен: "
                  "он больше не будет показан", file=sys.stderr)
        elif args.command == "list":
            for record in auth.load_tokens(args.file):
                status = f"revoked={record['revoked']}" if record.get("revoked") else "active"
                print(f"{record.get('prefix')} owner={record.get('owner')} "
                      f"created={record.get('created')} {status}")
        else:
            record = auth.revoke_token(args.prefix, args.file)
            if record is None:
                print("Активный токен с таким prefix не найден или prefix неоднозначен",
                      file=sys.stderr)
                return 1
            print(f"Отозван токен {record['prefix']} owner={record['owner']}")
    except (OSError, RuntimeError, ValueError) as e:
        print(str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
