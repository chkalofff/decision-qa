"""Argparse surface and stable process exits for the dqa executable."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

from . import SCHEMA, cli_version
from .client import Client, DqaError
from .config import initialize, resolve, set_value, show
from .doctor import run as run_doctor
from .inputs import build_plan, processed_counts
from .pack import capabilities_for, load, validate_fail_on


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise DqaError(64, f"{message}\nИспользуйте {self.prog} --help для справки.")


def connection_parser() -> Parser:
    parser = Parser(add_help=False)
    parser.add_argument("--server")
    parser.add_argument("--profile")
    return parser


def input_parser() -> Parser:
    parser = Parser(add_help=False)
    parser.add_argument("materials", nargs="*", metavar="МАТЕРИАЛ")
    parser.add_argument("--config", required=True, help="Конфиг-пакет v1, экспортированный из веба")
    parser.add_argument("--models")
    parser.add_argument("--mode", choices=("decisions", "fast_batch", "both"))
    parser.add_argument("--threads", type=int)
    parser.add_argument("--glob", default=None, metavar="PATTERN")
    parser.add_argument("--recursive", "-r", action="store_true")
    parser.add_argument("--files-from")
    parser.add_argument("--null", action="store_true")
    parser.add_argument("--manifest")
    parser.add_argument("--image", action="append")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--name")
    parser.add_argument("--format", choices=("json", "ndjson", "csv", "table"), default="json")
    parser.add_argument("--skip-processed")
    parser.add_argument("--encoding", choices=("utf-8", "cp1251"), default="utf-8")
    parser.add_argument("--fail-on", default="error")
    parser.add_argument("--timeout", type=float, default=0.0)
    parser.add_argument("--retry", type=int, default=2)
    parser.add_argument("--dry-run", action="store_true")
    verbosity = parser.add_mutually_exclusive_group()
    verbosity.add_argument("--quiet", action="store_true")
    verbosity.add_argument("--verbose", action="store_true")
    return parser


def build_parser() -> Parser:
    parser = Parser(prog="dqa", description="Decision-QA: конвейерная проверка материалов через сервер")
    parser.add_argument("--debug", action="store_true", help=argparse.SUPPRESS)
    subparsers = parser.add_subparsers(dest="command", required=True)
    parents = [connection_parser()]
    inputs = [connection_parser(), input_parser()]
    run = subparsers.add_parser("run", parents=inputs, help="Запустить серверный прогон; --dry-run выполняет validate")
    run.add_argument("--output", "-o", help="Записать выбранный stdout-формат в файл атомарно")
    run.add_argument("--report", help="Полный unfiltered JSON/NDJSON audit report")
    run.add_argument("--outcome-filter", help="Показать только outcome id через запятую")
    run.set_defaults(handler=_run)
    validate = subparsers.add_parser("validate", parents=inputs, help="Проверить пакет, сервер и вход без inference")
    validate.set_defaults(handler=_validate)
    pack = subparsers.add_parser("pack", help="Операции с конфиг-пакетами")
    pack_sub = pack.add_subparsers(dest="pack_command", required=True)
    pack_show = pack_sub.add_parser("show", parents=parents, help="Показать вопросы, исходы, модели и хэши")
    pack_show.add_argument("pack_path")
    pack_show.add_argument("--models")
    pack_show.add_argument("--mode", choices=("decisions", "fast_batch", "both"))
    pack_show.set_defaults(handler=_pack_show)
    config = subparsers.add_parser("config", parents=parents, help="Профили подключения")
    config_sub = config.add_subparsers(dest="config_command", required=True)
    config_init = config_sub.add_parser("init", parents=parents, help="Создать config.toml с правами 600")
    config_init.set_defaults(handler=_config_init)
    config_set = config_sub.add_parser("set", parents=parents, help="Установить server, token или default_profile")
    config_set.add_argument("key")
    config_set.add_argument("value")
    config_set.set_defaults(handler=_config_set)
    config_show = config_sub.add_parser("show", parents=parents, help="Эффективные значения и их источники")
    config_show.set_defaults(handler=_config_show)
    doctor = subparsers.add_parser("doctor", parents=parents, help="Проверить среду, сервер, auth, модели и пакет")
    doctor.add_argument("--config")
    doctor.add_argument("--format", choices=("json",), default=None)
    doctor.set_defaults(handler=_doctor)
    version = subparsers.add_parser("version", parents=parents, help="Версии CLI/server и совместимость схемы")
    version.set_defaults(handler=_version)
    explain = subparsers.add_parser("explain", help="Показать решение и ответы материала из локального отчёта")
    explain.add_argument("path")
    explain.add_argument("--report", required=True)
    explain.set_defaults(handler=_explain)
    diff = subparsers.add_parser("diff", help="Сравнить два полных отчёта по content_sha256")
    diff.add_argument("first")
    diff.add_argument("second")
    diff.add_argument("--format", choices=("json", "table"), default=None)
    diff.set_defaults(handler=_diff)
    return parser


def _config(args: argparse.Namespace):
    return resolve(server=args.server, profile=args.profile)


def _client(args: argparse.Namespace) -> Client:
    config = _config(args)
    return Client(config.server, config.token, verbose=getattr(args, "verbose", False),
                  deadline=getattr(args, "deadline", None))


def _check_prepare_deadline(args: argparse.Namespace) -> None:
    deadline = getattr(args, "deadline", None)
    if deadline is not None and time.monotonic() >= deadline:
        raise DqaError(75, "Истёк --timeout во время подготовки входа.")


def _prepare_inputs(args: argparse.Namespace):
    _check_prepare_deadline(args)
    if args.threads is not None and args.threads < 1:
        raise DqaError(64, "--threads должен быть положительным целым.")
    if args.timeout < 0 or args.retry < 0:
        raise DqaError(64, "--timeout и --retry не могут быть отрицательными.")
    args.glob = args.glob if args.glob is not None else ("**/*" if args.recursive else "*")
    pack = load(args.config, args.models, args.mode)
    _check_prepare_deadline(args)
    validate_fail_on(pack, args.fail_on)
    args.filter_ids = None
    raw_filter = getattr(args, "outcome_filter", None)
    if raw_filter is not None:
        requested = raw_filter.split(",")
        outcomes = {outcome["id"] for outcome in pack.original["decision"]["outcomes"]}
        if any(not item or item not in outcomes for item in requested):
            raise DqaError(64, f"--outcome-filter: ожидаются id из пакета: {', '.join(sorted(outcomes))}.")
        args.filter_ids = set(requested)
    client = _client(args)
    capabilities = capabilities_for(client, pack, SCHEMA)
    _check_prepare_deadline(args)
    if args.threads is not None and args.threads > capabilities["max_threads"]:
        raise DqaError(64, f"--threads больше серверного max_threads={capabilities['max_threads']}.")
    plan = build_plan(args, capabilities)
    _check_prepare_deadline(args)
    if any(material.images for material in plan.materials):
        if pack.mode != "decisions":
            raise DqaError(65, "Изображения поддерживаются только в режиме decisions; fast_batch/both отклонены до inference.")
        models = {model.get("key"): model for model in capabilities.get("models", [])}
        if not any(models[key].get("vision") for key in pack.models):
            raise DqaError(65, "Среди effective models нет vision-модели для входа с изображениями.")
    return pack, client, capabilities, plan


def _validate(args: argparse.Namespace) -> int:
    if args.format != "json":
        raise DqaError(64, "dqa validate поддерживает только --format json.")
    pack, _client_value, _capabilities, plan = _prepare_inputs(args)
    outcome_ids = {outcome["id"] for outcome in pack.original["decision"]["outcomes"]}
    processed = processed_counts(plan, args.skip_processed, pack.effective["fingerprint"], outcome_ids) if args.skip_processed else None
    _json(plan.summary(pack, skip_processed=processed))
    return 0


def _path_alias(value: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(value))))


def _run(args: argparse.Namespace) -> int:
    args.deadline = time.monotonic() + args.timeout if args.timeout > 0 else None
    if args.dry_run:
        return _validate(args)
    if args.format == "table" and (args.output or not sys.stdout.isatty()):
        raise DqaError(64, "--format table доступен только в TTY; для файла/пайпа используйте json, ndjson или csv.")
    if args.output and args.report and _path_alias(args.output) == _path_alias(args.report):
        raise DqaError(64, "--output и --report должны быть разными файлами.")
    pack, client, capabilities, plan = _prepare_inputs(args)
    from contextlib import nullcontext
    from .processed import ProcessedManifest
    from .reports import FanoutWriter, NDJSONWriter, ReportArtifact, atomic_text, supports_ansi, write_selected
    from .runner import execute_run
    lock = ProcessedManifest(args.skip_processed, pack.effective["fingerprint"], deadline=args.deadline) if args.skip_processed else nullcontext(None)
    output_context = atomic_text(args.output) if args.output and args.output != "-" else nullcontext(sys.stdout)
    artifact = ReportArtifact(args.report, len(plan.records), pack) if args.report else None
    outcome = None
    try:
        with lock as manifest, output_context as stream:
            writers = []
            if args.format == "ndjson":
                writers.append(NDJSONWriter(stream, args.filter_ids))
            if artifact and artifact.event_writer:
                writers.append(artifact.event_writer)
            outcome = execute_run(plan=plan, pack=pack, client=client, capabilities=capabilities,
                                  args=args, manifest=manifest,
                                  event_writer=FanoutWriter(*writers) if writers else None,
                                  stream_events=bool(writers))
            if args.format != "ndjson":
                write_selected(outcome, stream, args.format, args.filter_ids,
                               color=supports_ansi(stream))
            if artifact:
                artifact.finish(outcome)
        if not args.quiet:
            print(f"итог: exit {outcome.exit_code} · {outcome.report_fields()['summary']}", file=sys.stderr)
        return outcome.exit_code
    except Exception:
        if artifact:
            artifact.abort()
        raise
    finally:
        if outcome is not None:
            outcome.close()


def _pack_show(args: argparse.Namespace) -> int:
    pack = load(args.pack_path, args.models, args.mode)
    if args.models is not None:
        capabilities_for(_client(args), pack, SCHEMA)
    _json(pack.summary())
    return 0


def _config_init(args: argparse.Namespace) -> int:
    from .config import config_path
    path = config_path()
    initialize(path, args.server or os.environ.get("DQA_SERVER", "http://localhost:8000"))
    _json({"config_path": str(path), "created": True})
    return 0


def _config_set(args: argparse.Namespace) -> int:
    from .config import config_path, load_file
    path = config_path()
    set_value(path, args.profile, args.key, args.value)
    selected = args.profile or load_file(path)["default_profile"]
    _json({"config_path": str(path), "updated": args.key, "profile": selected})
    return 0


def _config_show(args: argparse.Namespace) -> int:
    _json(show(_config(args)))
    return 0


def _doctor(args: argparse.Namespace) -> int:
    code, checks = run_doctor(_config(args), args.config, as_json=args.format == "json")
    if args.format == "json":
        _json({"ok": code == 0, "checks": checks})
    return code


def _version(args: argparse.Namespace) -> int:
    client = _client(args)
    server = client.version()["version"]
    capabilities = client.capabilities()
    from .pack import schema_check
    schema_check(capabilities, SCHEMA)
    _json({"cli_version": cli_version(), "server": client.server, "server_version": server,
           "schema": SCHEMA, "compatible": True})
    return 0


def _explain(args: argparse.Namespace) -> int:
    from .analysis import explain
    _json(explain(args.report, args.path))
    return 0


def _diff(args: argparse.Namespace) -> int:
    from .analysis import diff, write_diff_table
    value = diff(args.first, args.second)
    output_format = args.format or ("table" if sys.stdout.isatty() else "json")
    if output_format == "table" and not sys.stdout.isatty():
        raise DqaError(64, "dqa diff --format table доступен только в TTY.")
    if output_format == "table":
        write_diff_table(value, sys.stdout)
    else:
        _json(value)
    return 0


def _json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))


def _configure_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass


def main(argv: list[str] | None = None) -> int:
    _configure_utf8()
    debug = bool(argv and "--debug" in argv) or ("--debug" in sys.argv[1:] if argv is None else False)
    try:
        if sys.version_info < (3, 12):
            raise DqaError(69, "dqa требует Python 3.12+. Обновите Python и повторите.")
        args = build_parser().parse_args(argv)
        return args.handler(args)
    except DqaError as exc:
        print(f"dqa: {exc.message}", file=sys.stderr)
        return exc.code
    except KeyboardInterrupt:
        print("dqa: прервано пользователем", file=sys.stderr)
        return 130
    except BrokenPipeError:
        return 0
    except Exception as exc:
        if debug:
            raise
        print(f"dqa: внутренняя ошибка: {exc}. Повторите с --debug для диагностики.", file=sys.stderr)
        return 70
