#!/usr/bin/env python3
"""
Prepare an n8n workflow export for version control.

What it does:
  - removes instance-specific metadata (instanceId, workflow id, versionId, pinned test data)
  - replaces credential IDs with a placeholder (the credential *name* is kept, so n8n
    prompts you to pick the matching credential on import)
  - forces "active": false so an import never collides with a running workflow's webhooks
  - sorts nodes by name and keys alphabetically, so successive exports produce small,
    readable git diffs
  - optionally swaps a real mailbox for a placeholder (keeps +tags), for public repos
  - scans the result for anything that looks like a secret and warns

Usage:
  python3 scripts/sanitize_export.py <n8n-export.json> [-o workflows/onboard-automation.json]
                                     [--redact-email you@gmail.com=automation.inbox@example.com]

Writes to workflows/onboard-automation.json by default. Standard library only.
"""
import argparse
import json
import re
import sys
from pathlib import Path

DROP_TOP_LEVEL = ("id", "versionId", "meta", "shared", "createdAt", "updatedAt", "triggerCount", "staticData")
SECRET_PATTERNS = [
    (re.compile(r"(?i)authorization\"?\s*:\s*\"(basic|bearer)\s+[a-z0-9+/=._-]{8,}"), "Authorization header value"),
    (re.compile(r"(?i)\"(password|client_secret|api[_-]?key|token|secret)\"\s*:\s*\"[^\"]{4,}\""), "secret-looking field"),
    (re.compile(r"\bsk-[A-Za-z0-9]{16,}"), "API key"),
]


def sanitize(wf: dict) -> dict:
    for key in DROP_TOP_LEVEL:
        wf.pop(key, None)
    wf["pinData"] = {}
    wf["active"] = False
    for node in wf.get("nodes", []):
        for cred in (node.get("credentials") or {}).values():
            if isinstance(cred, dict) and "id" in cred:
                cred["id"] = "REPLACE_ON_IMPORT"
    wf["nodes"] = sorted(wf.get("nodes", []), key=lambda n: n.get("name", ""))
    return wf


def redact_email(text: str, real: str, placeholder: str) -> str:
    real_local, real_domain = real.split("@", 1)
    ph_local, ph_domain = placeholder.split("@", 1)
    pattern = re.compile(re.escape(real_local) + r"(\+[\w-]+)?@" + re.escape(real_domain), re.IGNORECASE)
    return pattern.sub(lambda m: f"{ph_local}{m.group(1) or ''}@{ph_domain}", text)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", type=Path, help="workflow JSON exported from n8n")
    ap.add_argument("-o", "--output", type=Path, default=Path("workflows/onboard-automation.json"))
    ap.add_argument("--redact-email", metavar="REAL=PLACEHOLDER", action="append", default=[],
                    help="replace a mailbox (and its +tag variants) with a placeholder; repeatable")
    args = ap.parse_args()

    wf = sanitize(json.loads(args.export.read_text(encoding="utf-8")))
    text = json.dumps(wf, indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    for pair in args.redact_email:
        real, _, placeholder = pair.partition("=")
        if "@" not in real or "@" not in placeholder:
            ap.error(f"--redact-email expects REAL=PLACEHOLDER, got {pair!r}")
        text = redact_email(text, real.strip(), placeholder.strip())

    warnings = [label for rx, label in SECRET_PATTERNS if rx.search(text)]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text, encoding="utf-8")

    print(f"Wrote {args.output} ({len(wf.get('nodes', []))} nodes, active=false, credential IDs replaced)")
    for w in warnings:
        print(f"WARNING: found a {w} in the output. Review before committing.", file=sys.stderr)
    return 1 if warnings else 0


if __name__ == "__main__":
    sys.exit(main())
