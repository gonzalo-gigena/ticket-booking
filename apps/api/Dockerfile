# syntax=docker/dockerfile:1
# ponytail: no build stage, the api is plain JS. Add one between deps and runtime when you add TypeScript or a bundler.
FROM node:26.13-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26.13-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# --chown: the node user must be able to write src/ so Compose Watch can sync into it
COPY --chown=node:node src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
