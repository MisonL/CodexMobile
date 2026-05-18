FROM node:20-slim

WORKDIR /app

COPY package*.json ./
COPY scripts/patch-codex-sdk.mjs scripts/patch-codex-sdk.mjs
RUN npm ci

COPY . .
RUN npm run build
RUN chown -R node:node /app

ENV HOST=0.0.0.0
ENV PORT=7860
ENV CODEXMOBILE_MODE=relay

EXPOSE 7860

USER node

CMD ["npm", "run", "start:relay"]
