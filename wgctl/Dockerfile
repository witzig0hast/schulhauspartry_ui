FROM node:22-alpine
RUN apk add --no-cache wireguard-tools bash iproute2
WORKDIR /app
COPY lib.js server.js ./
CMD ["node", "server.js"]
