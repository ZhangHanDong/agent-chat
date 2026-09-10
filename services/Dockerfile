FROM node:22-bookworm-slim

WORKDIR /opt/hagency

RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node . .

RUN chmod 0755 services/run-bridge-container.sh

RUN mkdir -p /var/lib/hagency/data /var/lib/hagency/logs \
    && chown -R node:node /var/lib/hagency

ENV NODE_ENV=production
ENV HAGENCY_RUNTIME_DIR=/var/lib/hagency

USER node
