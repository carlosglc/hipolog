# node:sqlite es parte del runtime desde Node 22, así que la imagen no
# necesita compilar nada nativo ni instalar dependencias en producción.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# El servidor MCP (src/mcp). Corre el TypeScript tal cual: Node 24 quita los
# tipos al cargar. Es la unica parte con dependencias de runtime (el SDK de
# MCP), por eso va en su propia imagen y la de la app sigue sin node_modules.
# Va ANTES de la etapa final para que `build: .` siga construyendo la app.
FROM node:24-alpine AS mcp
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/lib ./src/lib
COPY src/mcp ./src/mcp
USER node
EXPOSE 3001
CMD ["node", "src/mcp/server.ts"]

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HIPOLOG_DB=/datos/hipolog.db
ENV BODY_SIZE_LIMIT=512K
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /datos && chown -R node:node /datos
USER node
VOLUME /datos
EXPOSE 3000
CMD ["node", "build"]
