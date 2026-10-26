#!/usr/bin/env python3
"""
Prove a sanitized workflow is the same workflow as the original n8n export.

It compares the two files node by node, after applying the changes the sanitizer is
*supposed* to make (metadata removed, credential IDs placeholdered, active=false, email
redaction). Anything else that differs is reported. Line numbers are ignored on purpose:
the sanitizer sorts nodes and keys, so text positions always move.

Usage:
  python3 scripts/verify_sanitized.py <original-export.json> [workflows/onboard-automation.json]
                                      [--redact-email REAL=PLACEHOLDER] [--find "some text"]

Pass the same --redact-email you gave the sanitizer. --find shows where a phrase lives in
each file (which node, which field). Exit code 0 means identical apart from expected changes.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sanitize_export import DROP_TOP_LEVEL, redact_email  # noqa: E402


def expected_from_original(raw: str, redactions):
    for real, placeholder in redactions:
        raw = redact_email(raw, real, placeholder)
    wf = json.loads(raw)
    for k in DROP_TOP_LEVEL:
        wf.pop(k, None)
    wf["pinData"], wf["active"] = {}, False
    for node in wf.get("nodes", []):
        for cred in (node.get("credentials") or {}).values():
            if isinstance(cred, dict) and "id" in cred:
                cred["id"] = "REPLACE_ON_IMPORT"
    return wf


def diff(a, b, path=""):
    if type(a) is not type(b):
        yield f"{path}: {json.dumps(a)[:80]} -> {json.dumps(b)[:80]}"
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in b:
                yield f"{path}.{k}: missing from sanitized file"
            elif k not in a:
                yield f"{path}.{k}: not in original"
            else:
                yield from diff(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        if len(a) != len(b):
            yield f"{path}: list length {len(a)} -> {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            yield from diff(x, y, f"{path}[{i}]")
    elif a != b:
        yield f"{path}: {json.dumps(a)[:80]} -> {json.dumps(b)[:80]}"


def find(wf, needle, path=""):
    if isinstance(wf, dict):
        for k, v in wf.items():
            yield from find(v, needle, f"{path}.{k}" if path else k)
    elif isinstance(wf, list):
        for i, v in enumerate(wf):
            label = v.get("name") if isinstance(v, dict) and "name" in v and "type" in v else i
            yield from find(v, needle, f"{path}[{label}]")
    elif isinstance(wf, str) and needle.lower() in wf.lower():
        yield path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("original", type=Path)
    ap.add_argument("sanitized", type=Path, nargs="?", default=Path("workflows/onboard-automation.json"))
    ap.add_argument("--redact-email", action="append", default=[], metavar="REAL=PLACEHOLDER")
    ap.add_argument("--find", action="append", default=[], metavar="TEXT")
    args = ap.parse_args()

    redactions = [tuple(s.strip() for s in p.split("=", 1)) for p in args.redact_email]
    orig_raw = args.original.read_text(encoding="utf-8")
    orig = json.loads(orig_raw)
    expected = expected_from_original(orig_raw, redactions)
    actual = json.loads(args.sanitized.read_text(encoding="utf-8"))

    e_nodes = {n["name"]: n for n in expected.get("nodes", [])}
    a_nodes = {n["name"]: n for n in actual.get("nodes", [])}
    problems = []
    for name in sorted(set(e_nodes) | set(a_nodes)):
        if name not in a_nodes:
            problems.append(f"node '{name}' is missing from the sanitized file")
        elif name not in e_nodes:
            problems.append(f"node '{name}' is in the sanitized file but not the original")
        else:
            problems += [f"node '{name}'{d}" for d in diff(e_nodes[name], a_nodes[name])]
    rest_e = {k: v for k, v in expected.items() if k != "nodes"}
    rest_a = {k: v for k, v in actual.items() if k != "nodes"}
    problems += [f"workflow{d}" for d in diff(rest_e, rest_a)]

    print(f"Original : {args.original}  ({len(orig.get('nodes', []))} nodes)")
    print(f"Sanitized: {args.sanitized}  ({len(actual.get('nodes', []))} nodes)")
    print(f"Connections: {sum(len(t) for c in actual.get('connections', {}).values() for o in c['main'] for t in [o or []])} links compared")
    removed = [k for k in DROP_TOP_LEVEL if k in orig] + (["pinData (test data)"] if orig.get("pinData") else [])
    print(f"Expected changes applied: removed {', '.join(removed) or 'nothing'}; credential IDs placeholdered; active=false"
          + (f"; {len(redactions)} email redaction(s)" if redactions else ""))

    for needle in args.find:
        print(f"\n'{needle}'")
        for label, wf in (("original", orig), ("sanitized", actual)):
            hits = list(find(wf, needle))
            print(f"  {label:9}: " + ("; ".join(hits) if hits else "not found"))

    if problems:
        print(f"\n{len(problems)} unexpected difference(s):")
        for p in problems[:50]:
            print("  - " + p)
        return 1
    print("\nOK: same nodes, parameters, code and connections. Only the expected sanitizer changes differ.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
