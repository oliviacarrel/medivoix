FROM node:22-alpine

# Build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Data directory for SQLite (override with volume or switch to PG)
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/data.db

EXPOSE 3000
CMD ["node", "server.js"]
