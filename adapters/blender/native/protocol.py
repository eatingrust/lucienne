"""Finite mailbox boundary. No request content is evaluated as Python."""
import json
import math
import os
from pathlib import Path
import re
import stat
import time

CATALOG = {c["id"]: tuple(c["values"]) for c in json.loads(
    (Path(__file__).resolve().parent.parent / "catalog.json").read_text())}
COMMANDS = {"hello", "apply", "readback", "observe", "restore", "close"}


class BridgeError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise BridgeError(code)


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid(), "UNSAFE_MAILBOX")
        require(info.st_size <= 65536, "MAILBOX_TOO_LARGE")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as stream:
            return json.load(stream)
    finally:
        os.close(fd)


def validate_request(value, token):
    require(isinstance(value, dict), "INVALID_REQUEST")
    require(set(value).issubset({"v", "id", "token", "runId", "requestId", "generation", "command", "operations"}), "INVALID_REQUEST")
    require(type(value.get("v")) is int and value["v"] == 1 and value.get("token") == token, "INVALID_TOKEN")
    for key in ("id", "runId", "requestId"):
        require(isinstance(value.get(key), str) and re.fullmatch(r"[A-Za-z0-9._:/-]{1,160}", value[key]), "INVALID_ID")
    require(type(value.get("generation")) is int and value["generation"] >= 0, "INVALID_GENERATION")
    require(isinstance(value.get("command"), str) and value["command"] in COMMANDS, "INVALID_COMMAND")
    if value["command"] == "apply":
        operations = value.get("operations")
        require(isinstance(operations, list) and len(operations) == len(CATALOG), "INCOMPLETE_PATCH")
        seen = set()
        for op in operations:
            require(isinstance(op, dict) and set(op) == {"capabilityId", "value"}, "INVALID_OPERATION")
            key = op["capabilityId"]
            require(isinstance(key, str) and key in CATALOG and key not in seen and isinstance(op["value"], str) and op["value"] in CATALOG[key], "UNSUPPORTED_OPERATION")
            seen.add(key)
        # Shortcuts are finite, but two actions may still collide in one native context.
        bindings = [op["value"] for op in operations if op["capabilityId"].startswith("blender.binding.") and op["value"] != "disabled"]
        require(len(bindings) == len(set(bindings)), "CONFLICTING_BINDINGS")
    else:
        require("operations" not in value, "UNEXPECTED_OPERATIONS")
    return value


def check_lease(lease, request, token, now_ms=None):
    require(isinstance(lease, dict), "INVALID_LEASE")
    require(lease.get("token") == token, "STALE_LEASE")
    require(type(lease.get("generation")) is int and all(lease.get(k) == request[k] for k in ("runId", "requestId", "generation")), "STALE_LEASE")
    expires = lease.get("expiresAt")
    require(type(expires) in (int, float) and math.isfinite(expires), "INVALID_LEASE")
    require((time.time() * 1000 if now_ms is None else now_ms) < expires, "EXPIRED_LEASE")


def guarded_mutation(guard, operation):
    """No async native writer; a revoked lease stops the next mutation, including cleanup."""
    guard()
    result = operation()
    guard()
    return result
