# Stage 1: Build
FROM --platform=linux/amd64 node:20-alpine AS builder

WORKDIR /app

# Enable Corepack to use Yarn
RUN corepack enable && corepack prepare yarn@1.22.19 --activate

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies with Yarn
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN yarn build

# Stage 2: Runtime
FROM --platform=linux/amd64 node:20-alpine AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Enable Corepack to use Yarn
RUN corepack enable && corepack prepare yarn@1.22.19 --activate

# Copy package files
COPY package.json yarn.lock ./

# Install production dependencies only
RUN yarn install --frozen-lockfile --production && yarn cache clean

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Change ownership
RUN chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application directly (dumb-init may cause exec format error on some platforms)
CMD ["node", "dist/main.js"]

