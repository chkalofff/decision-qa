"""Versioned append-only processed manifest and cross-process single-writer lock."""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, BinaryIO, Iterator

from dqa_common.config_pack import canonical_bytes

from .client import DqaError

MANIFEST_VERSION = 1


def processed_key(content_sha256: str, effective_fingerprint: str) -> str:
    projection = {"content_sha256": content_sha256, "effective_fingerprint": effective_fingerprint}
    return "sha256:" + hashlib.sha256(canonical_bytes(projection)).hexdigest()


def reusable_entry(entry: dict[str, Any], effective_fingerprint: str,
                   outcome_ids: set[str]) -> bool:
    return entry["fingerprint"] == effective_fingerprint and entry["outcome"] in outcome_ids


def parse_entries(lines: Iterator[bytes], path: Path) -> Iterator[dict[str, Any]]:
    for number, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise DqaError(65, f"{path}:{number}: невалидный NDJSON: {exc}") from exc
        if not isinstance(value, dict) or value.get("version") != MANIFEST_VERSION:
            raise DqaError(65, f"{path}:{number}: ожидался manifest version {MANIFEST_VERSION}.")
        if not all(isinstance(value.get(key), str) and value[key] for key in ("key", "fingerprint", "outcome", "run_id")):
            raise DqaError(65, f"{path}:{number}: нужны строковые key/fingerprint/outcome/run_id.")
        yield value


def read_entries(filename: str) -> Iterator[dict[str, Any]]:
    path = Path(filename)
    try:
        if path.exists():
            with path.open("rb") as stream:
                yield from parse_entries(stream, path)
    except OSError as exc:
        raise DqaError(65, f"Не удалось прочитать --skip-processed {path}: {exc}") from exc


class ProcessedManifest:
    def __init__(self, filename: str, effective_fingerprint: str, *, deadline: float | None = None):
        self.path = Path(filename)
        self.fingerprint = effective_fingerprint
        self.deadline = deadline
        self.stream: BinaryIO | None = None
        self._lock_handle: int | None = None
        self._overlapped: Any = None

    def __enter__(self) -> "ProcessedManifest":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.stream = self.path.open("a+b")
            if os.name == "posix":
                os.chmod(self.path, 0o600)
            self._lock()
        except DqaError:
            self.close()
            raise
        except OSError as exc:
            self.close()
            raise DqaError(70, f"Не удалось открыть --skip-processed {self.path}: {exc}") from exc
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _lock(self) -> None:
        deadline = time.monotonic() + 5.0
        while True:
            try:
                if os.name == "posix":
                    import fcntl
                    fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    self._lock_windows()
                return
            except (BlockingIOError, OSError) as exc:
                if os.name != "posix" and not _windows_lock_busy(exc):
                    raise DqaError(70, f"Не удалось заблокировать манифест {self.path}: {exc}") from exc
                if self.deadline is not None and time.monotonic() >= self.deadline:
                    raise DqaError(75, "Истёк --timeout во время ожидания блокировки манифеста.") from exc
                if time.monotonic() >= deadline:
                    raise DqaError(70, f"Манифест {self.path} занят другим процессом dqa; дождитесь его или используйте отдельный манифест.") from exc
                time.sleep(0.1)

    def _lock_windows(self) -> None:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        class OVERLAPPED(ctypes.Structure):
            _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                        ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                        wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(OVERLAPPED)]
        self._lock_handle = msvcrt.get_osfhandle(self.stream.fileno())
        self._overlapped = OVERLAPPED()
        ok = kernel32.LockFileEx(wintypes.HANDLE(self._lock_handle), 0x00000002 | 0x00000001,
                                 0, 1, 0, ctypes.byref(self._overlapped))
        if not ok:
            error = ctypes.get_last_error()
            raise OSError(error, "LockFileEx failed")

    def close(self) -> None:
        if self.stream is None:
            return
        try:
            if self._lock_handle is not None:
                import ctypes
                from ctypes import wintypes
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel32.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                  wintypes.DWORD, wintypes.DWORD,
                                                  ctypes.POINTER(type(self._overlapped))]
                kernel32.UnlockFileEx(wintypes.HANDLE(self._lock_handle), 0, 1, 0, ctypes.byref(self._overlapped))
            elif os.name == "posix":
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self.stream.close()
            self.stream = None
            self._lock_handle = None

    def entries(self) -> Iterator[dict[str, Any]]:
        self.stream.seek(0)
        for entry in parse_entries(self.stream, self.path):
            if self.deadline is not None and time.monotonic() >= self.deadline:
                raise DqaError(75, "Истёк --timeout во время чтения манифеста.")
            yield entry

    def latest_by_key(self) -> dict[str, dict[str, Any]]:
        latest = {}
        for entry in self.entries():
            latest[entry["key"]] = entry
        return latest

    def append(self, *, key: str, outcome: str, run_id: str, content_sha256: str) -> None:
        record = {
            "version": MANIFEST_VERSION, "key": key, "fingerprint": self.fingerprint,
            "outcome": outcome, "run_id": run_id, "content_sha256": content_sha256,
        }
        self.stream.seek(0, os.SEEK_END)
        self.stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n")
        self.stream.flush()
        os.fsync(self.stream.fileno())


def _windows_lock_busy(exc: OSError) -> bool:
    return getattr(exc, "winerror", None) in {32, 33, 158} or exc.errno in {13, 36}
