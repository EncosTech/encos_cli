#!/bin/bash
# SPDX-License-Identifier: MIT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v clang-format &>/dev/null; then
    echo "clang-format not found — skipping format check"
    exit 0
fi

MODE="fix"
if [[ "${1:-}" == "--check" ]]; then
    MODE="check"
fi

mapfile -t FILES < <(
    find \
        "${ROOT_DIR}/main.cc" \
        "${ROOT_DIR}/cli_command.cc" \
        "${ROOT_DIR}/cli_command.h" \
        "${ROOT_DIR}/components" \
        "${ROOT_DIR}/src" \
        "${ROOT_DIR}/tests" \
        -type f \( -name '*.cc' -o -name '*.h' \) \
        | sort
)

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "No project source files found."
    exit 0
fi

if [[ "${MODE}" == "check" ]]; then
    clang-format --dry-run --Werror "${FILES[@]}"
else
    clang-format -i "${FILES[@]}"
fi

echo "clang-format ${MODE} passed"
