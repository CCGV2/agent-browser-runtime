FROM node:22.22.2-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       dbus-x11 \
       fonts-liberation \
       novnc \
       openbox \
       tini \
       util-linux \
       websockify \
       x11-utils \
       x11vnc \
       xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-browser
COPY package.json package-lock.json ./
COPY browser-broker.cjs browser-client.cjs session-pool.cjs ./
COPY docker-focus.cjs desktop-config.cjs ./
RUN npm ci --omit=dev \
    && npx playwright-core install --with-deps chromium \
    && npm cache clean --force \
    && mkdir -p /data/profile /data/artifacts /data/logs /home/node/.cache \
    && chown -R node:node /opt/agent-browser /ms-playwright /data /home/node/.cache

COPY --chown=root:root desktop-entrypoint.sh playwright-mcp-wrapper.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/desktop-entrypoint.sh /usr/local/bin/playwright-mcp-wrapper.sh \
    && chmod 0644 /opt/agent-browser/*.cjs /opt/agent-browser/package*.json

USER node
WORKDIR /opt/agent-browser
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/desktop-entrypoint.sh"]
