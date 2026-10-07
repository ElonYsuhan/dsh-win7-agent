#!/usr/bin/env python3
"""Print the Library runtime mode as one JSON record."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from _common import is_sandbox, safe_print  # noqa: E402


def main() -> None:
    payload = {"mode": "sandbox" if is_sandbox() else "client"}
    safe_print(
        "KS_LIBRARY_RUNTIME "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


if __name__ == "__main__":
    main()
