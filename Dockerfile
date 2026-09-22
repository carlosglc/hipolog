# node:sqlite es parte del runtime desde Node 22, así que la imagen no
# necesita compilar nada nativo ni instalar dependencias en producción.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

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
