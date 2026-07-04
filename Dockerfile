# Multi-stage build: compile the monorepo, ship a lean runtime image.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

ENV PORT=3000
ENV DATABASE_PATH=/data/media-league.db
ENV DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server/dist/index.js"]
