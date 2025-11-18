# Use a imagem oficial Playwright (com Chromium instalado)
FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --unsafe-perm

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 10000

CMD ["node", "index.js"]
