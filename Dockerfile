FROM node:22-alpine AS dashboard-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY services/dashboard/vite.config.js ./services/dashboard/vite.config.js
COPY services/dashboard/ui ./services/dashboard/ui
RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY services ./services
COPY --from=dashboard-build /app/services/dashboard/public ./services/dashboard/public
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3001 3002 3003 3004
CMD ["sh", "-c", "node services/${SERVICE:?SERVICE must be set}/server.js"]
