# Built locally by the Supervisor — no registry involved. BUILD_FROM is supplied
# per architecture from build.yaml.
# The default only serves plain `docker build` for local testing; the Supervisor
# always supplies BUILD_FROM from build.yaml.
ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM}

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so a source-only change doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Config comes from /data/options.json, which the Supervisor writes whenever the
# App's Configuration tab is saved — no bashio or shell parsing needed.
CMD ["node", "src/index.js"]
