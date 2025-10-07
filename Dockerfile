## Playwright-friendly base image that already includes browsers & deps
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# Copy package manifests and install production deps
COPY package*.json ./
RUN npm ci --only=production

# Copy app code
COPY . .

# Ensure uploads dir exists
RUN mkdir -p uploads

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["npm", "start"]