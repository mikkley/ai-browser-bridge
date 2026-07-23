FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production PORT=3020
EXPOSE 3020
CMD ["node", "dist/server.js"]
