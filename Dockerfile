# Stage 1: Build
FROM --platform=linux/amd64 node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY package-lock.json* ./
COPY yarn.lock* ./

# Install dependencies
# Use npm if package-lock.json exists, otherwise use yarn
RUN if [ -f package-lock.json ]; then \
      npm ci --legacy-peer-deps; \
    elif [ -f yarn.lock ]; then \
      yarn install --frozen-lockfile; \
    else \
      npm install --legacy-peer-deps; \
    fi

# Copy source code
COPY . .

# Build the application
RUN if [ -f package-lock.json ]; then npm run build; else yarn build; fi

# Stage 2: Runtime
FROM --platform=linux/amd64 node:20-alpine AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Copy package files
COPY package.json ./
COPY package-lock.json* ./
COPY yarn.lock* ./

# Install production dependencies only
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --legacy-peer-deps && npm cache clean --force; \
    elif [ -f yarn.lock ]; then \
      yarn install --frozen-lockfile --production && yarn cache clean; \
    else \
      npm install --omit=dev --legacy-peer-deps && npm cache clean --force; \
    fi

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

