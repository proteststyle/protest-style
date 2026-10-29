FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://localhost:3000/api/health || exit 1
CMD ["node", "server/index.js"]
