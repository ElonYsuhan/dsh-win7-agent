#!/usr/bin/env python3
"""Call one SpaceEngine agent API using the packaged apispec manifest."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print, unwrap_data  # noqa: E402


class CliError(Exception):
    pass


def load_manifest() -> Dict[str, Any]:
    with (ROOT / "api-manifest.json").open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest.get("apis"), list):
        raise CliError("invalid api-manifest.json")
    return manifest


def camel_to_kebab(value: str) -> str:
    out = []
    for char in value:
        if char.isupper() and out:
            out.append("-")
        out.append(char.lower())
    return "".join(out)


def api_action(api: Mapping[str, Any]) -> str:
    return str(api.get("path", "")).rstrip("/").split("/")[-1]


def resolve_api(manifest: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    matches = [
        api
        for api in manifest["apis"]
        if name in (api.get("name"), api.get("path"), api_action(api))
    ]
    if not matches:
        raise CliError("unknown api: %s" % name)
    if len(matches) > 1:
        raise CliError("ambiguous api: %s" % name)
    return matches[0]


def flag_specs(api: Mapping[str, Any]) -> Dict[str, Mapping[str, Any]]:
    specs: Dict[str, Mapping[str, Any]] = {}
    for spec in api.get("args") or []:
        if not isinstance(spec, dict):
            continue
        name = spec.get("name")
        if name:
            specs[str(name)] = spec
            specs[camel_to_kebab(str(name))] = spec
    return specs


def parse_bool(value: str) -> bool:
    value = value.lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    raise CliError("invalid bool: %s" % value)


def needs_json(spec: Mapping[str, Any]) -> bool:
    typ = str(spec.get("type") or "").lower()
    primitives = {"", "string", "bool", "boolean", "int", "int32", "int64", "uint32", "uint64"}
    return typ not in primitives or bool(spec.get("children"))


def coerce(value: str, spec: Mapping[str, Any]) -> Any:
    typ = str(spec.get("type") or "string").lower()
    if typ in ("bool", "boolean"):
        return parse_bool(value)
    if typ in ("int", "int32", "int64", "uint32", "uint64"):
        return int(value)
    if needs_json(spec):
        return json.loads(value)
    return value


def parse_json_object(raw: str) -> Dict[str, Any]:
    if not raw.strip():
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise CliError("stdin JSON must be an object")
    return value


def parse_flags(tokens: Sequence[str], api: Mapping[str, Any]) -> Dict[str, Any]:
    specs = flag_specs(api)
    payload: Dict[str, Any] = {}
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if not token.startswith("--"):
            raise CliError("unexpected argument: %s" % token)
        key = token[2:]
        raw_value = None
        if "=" in key:
            key, raw_value = key.split("=", 1)
        spec = specs.get(key)
        if not spec:
            raise CliError("unknown argument: --%s" % key)
        if raw_value is None:
            is_bool = str(spec.get("type") or "").lower() in ("bool", "boolean")
            if is_bool and (i + 1 >= len(tokens) or tokens[i + 1].startswith("--")):
                raw_value = "true"
            else:
                if i + 1 >= len(tokens):
                    raise CliError("missing value for --%s" % key)
                i += 1
                raw_value = tokens[i]
        payload[str(spec.get("name"))] = coerce(raw_value, spec)
        i += 1
    return payload


def validate_required(api: Mapping[str, Any], payload: Mapping[str, Any]) -> None:
    missing = []
    for spec in api.get("args") or []:
        if not isinstance(spec, dict) or not spec.get("required"):
            continue
        name = str(spec.get("name"))
        value = payload.get(name)
        if value is None or value == "":
            missing.append(name)
    if missing:
        raise CliError("missing required argument(s): %s" % ", ".join(missing))


def response_data(api: Mapping[str, Any], envelope: Mapping[str, Any]) -> Dict[str, Any]:
    if str(api.get("response") or "").lower() == "direct":
        return dict(envelope)
    return unwrap_data(envelope)


def flag_name(spec: Mapping[str, Any]) -> str:
    return "--%s" % camel_to_kebab(str(spec.get("name")))


def print_general_help(manifest: Mapping[str, Any]) -> None:
    token_flag = "" if _common.is_sandbox() else " --token-stdin"
    print("usage: space_api.py <api>%s [--stdin] [--raw] [api args]" % token_flag)
    print("")
    print("apis:")
    for api in manifest.get("apis") or []:
        print("  %s" % api.get("name"))
    print("")
    print("run: space_api.py <api> --help")


def print_api_help(api: Mapping[str, Any]) -> None:
    flags = []
    for spec in api.get("args") or []:
        if isinstance(spec, dict) and spec.get("name"):
            suffix = " VALUE"
            if str(spec.get("type") or "").lower() in ("bool", "boolean"):
                suffix = ""
            flags.append("%s%s" % (flag_name(spec), suffix))
    token_flag = "" if _common.is_sandbox() else " --token-stdin"
    print("usage: space_api.py %s%s [--stdin] [--raw]%s" % (
        api.get("name"),
        token_flag,
        " " + " ".join("[%s]" % flag for flag in flags) if flags else "",
    ))
    print("method: %s" % api.get("method"))
    print("path: %s" % api.get("path"))
    if not flags:
        return
    print("")
    print("args:")
    for spec in api.get("args") or []:
        if not isinstance(spec, dict) or not spec.get("name"):
            continue
        required = ", required" if spec.get("required") else ""
        print("  %s (%s%s)" % (flag_name(spec), spec.get("type", "string"), required))


def parse_args(argv: Optional[Sequence[str]]) -> Tuple[argparse.Namespace, List[str]]:
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("api", nargs="?")
    parser.add_argument("-h", "--help", action="store_true")
    _common.register_token_arg(parser)
    parser.add_argument("--stdin", action="store_true", dest="read_stdin")
    parser.add_argument("--raw", action="store_true", help="print raw backend response for debugging")
    return parser.parse_known_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        args, rest = parse_args(argv)
        manifest = load_manifest()
        if args.help or not args.api:
            if args.api:
                print_api_help(resolve_api(manifest, args.api))
            else:
                print_general_help(manifest)
            return 0
        if not args.token_stdin and not _common.is_sandbox():
            raise CliError("客户端模式必须使用 --token-stdin；沙箱模式无需该参数")
        token = _common.acquire_token()
        api = resolve_api(manifest, args.api)
        payload = parse_json_object(sys.stdin.read()) if args.read_stdin else {}
        payload.update(parse_flags(rest, api))
        validate_required(api, payload)

        method = str(api.get("method") or "POST").upper()
        url = _common.build_url(api["path"])
        envelope = http_request(
            method,
            url,
            token,
            params=payload if method == "GET" else None,
            body=None if method == "GET" else payload,
        )
        traceid = getattr(envelope, "traceid", None)
        if args.raw:
            output = dict(envelope)
            if traceid:
                output["traceid"] = traceid
        else:
            output = {"api": api.get("name"), "data": response_data(api, envelope)}
            if traceid:
                output["traceid"] = traceid
        safe_print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    except HttpError as exc:
        error_exit(str(exc), traceid=getattr(exc, "traceid", None))
    except (CliError, ValueError, json.JSONDecodeError) as exc:
        error_exit(str(HttpError("invalid cli input", error_code="INVALID_PARAMS", backend_message=exc)))
    except Exception:
        error_exit(str(HttpError("space_api failed", error_code="TEMPORARY_ERROR")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
