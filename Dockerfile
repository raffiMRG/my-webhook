FROM node:24-alpine

WORKDIR /app

# Install dependencies (layer cached separately from source)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Prepare data directory with correct ownership before switching user
RUN mkdir -p data && chown -R node:node /app

EXPOSE 3000

USER node

CMD ["node", "server.js"]
