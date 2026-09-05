#!/usr/bin/env python3
"""Export current public plugin sources without local credentials or runtime data."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def export(destination):
    root = Path(__file__).resolve().parents[1]
    destination = destination.expanduser().resolve()
    if destination == root or root in destination.parents:
        raise ValueError("destination must be outside the repository")
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
    ).decode().split("\0")
    files = []
    for name in sorted(set(names)):
        if name not in ("README.md", ".agents/plugins/marketplace.json") and not name.startswith("plugins/"):
            continue
        relative = Path(name)
        if any(part in {".env", "state", "node_modules", ".browser-profile"} for part in relative.parts):
            raise ValueError(f"private/runtime path is not ignored: {name}")
        source = root / relative
        if source.is_symlink() or root not in source.resolve().parents:
            raise ValueError(f"plugin source must be an in-repository regular file: {name}")
        if source.is_file():
            files.append((relative, source))
    if not any(str(relative) == ".agents/plugins/marketplace.json" for relative, _ in files):
        raise ValueError("marketplace manifest is missing")
    destination.mkdir(parents=True, exist_ok=False)
    hashes = {}
    try:
        for relative, source in files:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            hashes[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()
        report = {
            "source": str(root),
            "collectedAt": datetime.now(timezone.utc).isoformat(),
            "method": "git ls-files --cached --others --exclude-standard; README + marketplace + plugins only",
            "redaction": "Git-ignored files excluded; private/runtime paths and symlinks rejected",
            "files": hashes,
        }
        (destination / "export-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    except Exception:
        shutil.rmtree(destination)
        raise
    print(json.dumps({"destination": str(destination), "files": len(files)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new directory outside this repository")
    export(parser.parse_args().destination)
