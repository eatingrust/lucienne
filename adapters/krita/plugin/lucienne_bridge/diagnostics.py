"""Bounded technical breadcrumbs; never a native acknowledgement or task proof."""
import json
import os
import pwd
import stat
import time

PHASES = frozenset({
    "module-import", "imports-ready", "import-failed", "setup-start", "setup-ready", "setup-failed",
    "command-received", "command-failed", "dispatch-start", "capture-start", "capture-ready",
    "prepare-start", "document-created", "layers-ready", "view-attached", "prepare-ready",
    "wait-start", "wait-ready", "wait-failed", "apply-start", "apply-ready",
    "response-written", "response-write-failed",
})
COMMANDS = frozenset({"hello", "apply", "readback", "observe", "restore", "close"})
ERROR_CLASSES = frozenset({
    "BridgeError", "ImportError", "ModuleNotFoundError", "PermissionError", "FileNotFoundError",
    "TypeError", "ValueError", "RuntimeError", "OSError", "AttributeError", "OverflowError",
})
HISTORY_LIMIT = 24
_history = []
_sequence = 0


def _open_directory():
    # Do not create directories, follow a directory symlink, or write for another account.
    directory = os.environ.get("LUCIENNE_KRITA_BRIDGE_DIR")
    token = os.environ.get("LUCIENNE_KRITA_TOKEN")
    if not directory or not token or len(token) < 32 or not os.path.isabs(directory):
        raise ValueError()
    uid = os.geteuid()
    if os.getuid() != uid or os.stat("/dev/console").st_uid != uid or pwd.getpwuid(uid).pw_name != "lucienne":
        raise PermissionError()
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
            raise PermissionError()
        return fd
    except Exception:
        os.close(fd)
        raise


def _uuid(value):
    return (isinstance(value, str) and len(value) == 36
            and all(value[i] == "-" for i in (8, 13, 18, 23))
            and all(c in "0123456789abcdefABCDEF" for i, c in enumerate(value) if i not in (8, 13, 18, 23)))


def mark_status(phase, command=None, request_id=None, error=None):
    """Best effort only: diagnostics never change command settlement or native work."""
    global _sequence
    if phase not in PHASES:
        return
    directory_fd = None
    temporary_fd = None
    temporary_name = None
    temporary_created = False
    try:
        directory_fd = _open_directory()
        error_class = None if error is None else type(error).__name__
        if error_class is not None and error_class not in ERROR_CLASSES:
            error_class = "Exception"
        _sequence += 1
        event = {"sequence": _sequence, "recordedAtMs": int(time.time() * 1000), "phase": phase,
                 "command": command if command in COMMANDS else None,
                 "id": request_id if _uuid(request_id) else None, "errorClass": error_class}
        _history.append(event)
        del _history[:-HISTORY_LIMIT]
        payload = {"v": 1, "kind": "krita-bridge-status", **event, "history": list(_history)}
        temporary_name = ".status-" + os.urandom(16).hex() + ".tmp"
        temporary_fd = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK,
                               0o600, dir_fd=directory_fd)
        temporary_created = True
        stream = os.fdopen(temporary_fd, "w", encoding="utf-8")
        temporary_fd = None  # The stream owns the descriptor, including on write failure.
        with stream:
            json.dump(payload, stream, separators=(",", ":"))
        os.replace(temporary_name, "status.json", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        temporary_created = False
    except Exception:
        pass
    finally:
        if temporary_fd is not None:
            try:
                os.close(temporary_fd)
            except Exception:
                pass
        if temporary_created:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except Exception:
                pass
        if directory_fd is not None:
            try:
                os.close(directory_fd)
            except Exception:
                pass
