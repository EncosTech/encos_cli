#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${1:-build}"

if ! command -v clang-tidy &>/dev/null; then
    echo "clang-tidy not found — skipping tidy check"
    exit 0
fi

if [[ ! -f "${BUILD_DIR}/compile_commands.json" ]]; then
    echo "compile_commands.json not found under ${BUILD_DIR} — run cmake configure first"
    exit 0
fi

mapfile -t FILES < <(
    python3 - "${BUILD_DIR}/compile_commands.json" "${ROOT_DIR}" <<'PY'
import json
import pathlib
import sys

compile_commands = pathlib.Path(sys.argv[1])
root_dir = pathlib.Path(sys.argv[2]).resolve()

with compile_commands.open() as f:
    entries = json.load(f)

seen = set()
files = []
for entry in entries:
    file_path = pathlib.Path(entry["file"]).resolve()
    if file_path.suffix != ".cc":
        continue
    try:
        rel = file_path.relative_to(root_dir)
    except ValueError:
        continue
    rel_str = rel.as_posix()
    if not (
        rel_str.startswith("src/")
        or rel_str.startswith("components/")
        or rel_str.startswith("tests/")
        or rel_str == "main.cc"
        or rel_str == "cli_command.cc"
    ):
        continue
    if rel_str not in seen:
        seen.add(rel_str)
        files.append(rel_str)

for path in sorted(files):
    print(path)
PY
)

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "No translation units found."
    exit 0
fi

for file in "${FILES[@]}"; do
    echo "Running clang-tidy: ${file}"
    clang-tidy -p "${BUILD_DIR}" "${file}"
done

echo "clang-tidy check passed"
