FROM node:22-alpine
WORKDIR /app
COPY package.json osc.js relay.js server.js ./
USER node
CMD ["node", "server.js"]
