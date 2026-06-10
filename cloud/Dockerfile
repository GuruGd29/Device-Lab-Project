# Cloud Control Plane. BUILD CONTEXT MUST BE THE REPO ROOT (so the contracts workspace is
# reachable). docker-compose sets context: . and dockerfile: cloud/Dockerfile accordingly.
FROM node:20-alpine AS build
WORKDIR /app

# Build the shared contracts package first.
COPY packages/contracts /app/packages/contracts
RUN cd /app/packages/contracts && npm install --no-audit --no-fund && npm run build

# Install + build the cloud plane against the built contracts.
COPY cloud/package.json /app/cloud/package.json
WORKDIR /app/cloud
RUN npm install --no-audit --no-fund --install-links /app/packages/contracts
COPY cloud/tsconfig.json ./
COPY cloud/src ./src
COPY cloud/migrations ./migrations
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app/cloud
ENV NODE_ENV=production
COPY --from=build /app/cloud/node_modules ./node_modules
COPY --from=build /app/cloud/dist ./dist
COPY --from=build /app/cloud/migrations ./migrations
COPY cloud/package.json ./
EXPOSE 8080
CMD ["node", "dist/index.js"]
