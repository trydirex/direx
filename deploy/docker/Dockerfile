# SPDX-License-Identifier: AGPL-3.0-only
# Direx with the CLI sandbox. Build from the repo root:
#   docker compose -f deploy/docker/compose.yml build
# Runs in production mode. To use it as a dev sandbox, set NODE_ENV=development in .env.

# whisper.cpp isn't packaged for trixie, so its CLI is built here and only the one binary is kept.
# GGML_NATIVE=OFF builds for any x86-64 or arm64 CPU, not just the one that ran the build.
FROM debian:trixie-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.9.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF \
 && cmake --build /build -j --target whisper-cli

FROM oven/bun:1.4.2-debian

# bubblewrap is the per-call sandbox around Claude Code, Codex and the clip tools. ffmpeg, its fonts
# and libgomp (whisper-cli's threads) are for clipping. The speech model is downloaded on first use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl ffmpeg fonts-dejavu-core libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
# Its MIT license asks for the notice to travel with the binary (THIRD_PARTY_NOTICES.md).
COPY --from=whisper /src/LICENSE /usr/share/licenses/whisper.cpp/LICENSE

# Codex comes with Direx as a dependency of apps/api (ADR 0036). Claude Code does not: uncomment the
# line below to install it when you build, for the bun user.
USER bun
# RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/bun/.local/bin:/home/bun/.bun/bin:${PATH}"
# Bun's own time zone data lags the world's; this points it at the newer copy in deploy/icu-tz.
ENV ICU_TIMEZONE_FILES_DIR=/app/deploy/icu-tz
# The data volume mounts here. Made by the bun user, so a new volume is bun's and the vault can
# write its key; a volume Docker creates over a missing path belongs to root.
RUN mkdir -p /home/bun/.direx

WORKDIR /app
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile
# The API serves the built web app itself; there is no Vite in the image. The web build generates
# its client from the API's OpenAPI document, which is not in git, so that is written first.
RUN bun apps/api/scripts/gen-openapi.ts && bun run --filter @direx/web build
ENV DIREX_WEB_DIST=/app/apps/web/dist

# `start` runs the app as bun's direct child, so a stop signal reaches it and it drains (ADR 0027).
# `dev`'s --filter and --watch wrapper does not pass the signal on.
CMD ["bun", "run", "start"]
