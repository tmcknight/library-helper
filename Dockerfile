FROM node:24-alpine
LABEL org.opencontainers.image.source=https://github.com/tmcknight/library-helper \
      org.opencontainers.image.description="MCP server for the Lambton County Library catalogue and patron account" \
      org.opencontainers.image.licenses=MIT
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "src/index.ts"]
