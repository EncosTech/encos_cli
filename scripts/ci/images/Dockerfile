# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Produced and verified on the corresponding native CI runner. No RUN step is
# needed here, so the image can be assembled without cross-architecture emulation.
ADD toolchain.tar.gz /opt/emcli-ci/20261123-v2/
ENV EMCLI_CI_TOOLCHAIN_ROOT=/opt/emcli-ci/20261123-v2 \
    COREPACK_ENABLE_NETWORK=0 \
    COREPACK_DEFAULT_TO_LATEST=0
