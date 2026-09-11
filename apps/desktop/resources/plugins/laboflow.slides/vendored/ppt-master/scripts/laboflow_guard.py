#!/usr/bin/env python3
"""LaboFlow AGPL/attribution guard (ADR-P4).

Runs at L2 runtime start. Exits non-zero when the vendored skill cannot be
used safely in a LaboFlow (proprietary) distribution:
1. PyMuPDF must NOT be importable (AGPL-3.0 — PDF route disabled).
2. The upstream LICENSE and our VENDOR files must be present.
"""
import importlib.util
import sys
from pathlib import Path

def main() -> int:
    root = Path(__file__).resolve().parent.parent
    errors = []
    for name in ("PyMuPDF", "fitz", "pymupdf"):
        if importlib.util.find_spec(name) is not None:
            errors.append(f"AGPL guard: {name} is importable but must not be installed")
    for required in ("LICENSE", "VENDOR_VERSION", "requirements-laboflow.txt"):
        if not (root / required).exists():
            errors.append(f"attribution: missing {required}")
    if errors:
        print("LABOFLOW GUARD FAILED:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 2
    print("guard ok: no AGPL deps, attribution intact")
    return 0

if __name__ == "__main__":
    sys.exit(main())
