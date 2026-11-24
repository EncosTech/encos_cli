#!/bin/sh
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT

# udev 在容器或离线安装环境中可能不可用。
if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules >/dev/null 2>&1 || true
fi
exit 0
