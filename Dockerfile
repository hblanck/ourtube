FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine
RUN apk add --no-cache ffmpeg python3 make g++
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME ["/data", "/media"]
CMD ["node", "src/server.js"]
