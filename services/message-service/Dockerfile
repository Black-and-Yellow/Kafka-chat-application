FROM node:22-alpine

WORKDIR /app

COPY services/message-service/package.json ./package.json
RUN npm install --omit=dev

COPY services/message-service/src ./src

ENV NODE_ENV=production
ENV MESSAGE_SERVICE_PORT=8090

EXPOSE 8090

CMD ["node", "src/index.js"]
