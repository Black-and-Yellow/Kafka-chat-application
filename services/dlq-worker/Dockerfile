FROM node:22-alpine
WORKDIR /app
COPY services/dlq-worker/package.json ./
RUN npm install --omit=dev
COPY services/dlq-worker/src ./src
CMD ["node", "src/index.js"]
