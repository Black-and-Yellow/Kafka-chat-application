FROM node:22-alpine

WORKDIR /app

COPY services/gateway/package.json ./package.json
RUN npm install --omit=dev

COPY services/gateway/src ./src

ENV NODE_ENV=production
ENV GATEWAY_PORT=8080

EXPOSE 8080

CMD ["node", "src/index.js"]
