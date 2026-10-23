FROM node:22-alpine
WORKDIR /app
COPY package.json osc.js relay.js server.js ./
RUN mkdir -p /app/state && chown node:node /app/state
USER node
CMD ["node", "server.js"]
