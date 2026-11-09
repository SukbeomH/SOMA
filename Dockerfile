# No Electron, Chromium, X11 server or virtual display in the runtime image.
FROM node:24-bookworm-slim AS node
FROM python:3.12-slim-bookworm AS base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates libgl1 libglu1-mesa libgomp1 libxrender1 libxext6 procps \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY --from=node /usr/local/include/node /usr/local/include/node
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/soma/app
COPY app/package*.json ./
# Skip desktop-only Electron/dugite downloads. Build the PTY for Node, not Electron.
RUN npm ci --ignore-scripts && npm_config_nodedir=/usr/local npm rebuild node-pty
COPY app/esbuild.config.mjs ./
COPY app/src ./src
COPY app/resources ./resources
RUN npm run build:web && npm prune --omit=dev --ignore-scripts
WORKDIR /opt/soma
COPY python ./python
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r python/requirements-web.txt \
 && /opt/venv/bin/pip install --no-cache-dir ./python
ARG CODEX_VERSION=0.167.0
RUN npm install --global --ignore-scripts @openai/codex@${CODEX_VERSION}

FROM base AS runtime
COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/soma/app/dist /opt/soma/app/dist
COPY --from=build /opt/soma/app/node_modules /opt/soma/app/node_modules
COPY --from=build /opt/soma/app/resources /opt/soma/app/resources
COPY --from=build /opt/soma/app/package.json /opt/soma/app/package.json
COPY --from=build /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
RUN ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
 && useradd --create-home --uid 10001 --shell /bin/bash soma \
 && mkdir -p /data /home/soma/.codex && chown -R soma:soma /data /home/soma
ENV SOMA_CONTAINER=1 SOMA_USER_DATA=/data SOMA_PYTHON=/opt/venv/bin/python \
    SHELL=/bin/bash LOCAL_GIT_DIRECTORY=/usr GIT_EXEC_PATH=/usr/lib/git-core \
    PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1
USER soma
WORKDIR /opt/soma/app
CMD ["node", "dist/web/server.js"]
