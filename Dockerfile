FROM mcr.microsoft.com/playwright:v1.49.0-focal

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --unsafe-perm

COPY . .

EXPOSE 10000

CMD ["node", "index.js"]
