# Base image is pinned here rather than via build.yaml.
#
# Two reasons, both learned the hard way:
#   - build.yaml is deprecated; the Supervisor asks for build parameters to live
#     in the Dockerfile. Its build_from values must also be namespaced paths, so
#     a bare "node:22-alpine" fails validation and the Supervisor silently falls
#     back to its default base — which has no Node in it.
#   - The Supervisor always passes --build-arg BUILD_FROM=<ha base image>. An
#     `ARG BUILD_FROM=node:22-alpine` default can therefore never take effect;
#     the injected value wins and the build dies on "npm: not found". So we
#     deliberately do NOT consume BUILD_FROM. Docker warns that the build arg is
#     unused; that warning is expected and correct.
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so a source-only change doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Config comes from /data/options.json, which the Supervisor writes whenever the
# App's Configuration tab is saved — no bashio or shell parsing needed.
CMD ["node", "src/index.js"]
