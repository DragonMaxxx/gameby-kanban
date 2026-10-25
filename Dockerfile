# Autor: Mateusz Bartoszewicz
# Etap 1: budowa strony z tablicą (esbuild i SDK Discorda są tylko tutaj, nie trafiają do obrazu z botem).
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY web ./web
RUN node scripts/build.js

# Etap 2: bot i serwer strony, tylko zależności produkcyjne.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY --from=build /build/public ./public
RUN mkdir -p /data && chown node:node /data
USER node
# Brak instrukcji VOLUME celowo: katalog /data podłącza docker-compose.yml (wolumen kanban-data) albo Railway (Volume zamontowany w /data).
# Zachowanie instrukcji VOLUME na Railway nie jest opisane w dokumentacji, więc jej nie używamy.
EXPOSE 8080
# Sprawdza tylko serwer strony (gdy nie ustawiono DISCORD_CLIENT_SECRET, strony nie ma i kontener uznajemy za zdrowy).
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "if(!process.env.DISCORD_CLIENT_SECRET)process.exit(0);fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
