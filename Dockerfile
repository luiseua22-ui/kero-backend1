FROM mcr.microsoft.com/playwright:v1.47.0-focal

WORKDIR /usr/src/app

COPY package.json ./
# Instala dependências exatas conforme o package.json
RUN npm install --unsafe-perm

# Garante dependências do SO
RUN npx playwright install-deps

COPY . .

EXPOSE 10000
CMD ["node", "index.js"]
