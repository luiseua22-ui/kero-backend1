FROM mcr.microsoft.com/playwright:v1.47.0-focal

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --unsafe-perm

# Garante que as dependencias do SO para o Chromium estejam instaladas
RUN npx playwright install-deps

COPY . .

EXPOSE 10000
CMD ["node", "index.js"]
