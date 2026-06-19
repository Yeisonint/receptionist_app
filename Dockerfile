# Stage 1: Build Angular
FROM node:22-alpine AS frontend-builder
WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js config.json ./
COPY --from=frontend-builder /build/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
