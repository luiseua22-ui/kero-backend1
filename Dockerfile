FROM mcr.microsoft.com/playwright:v1.56.1-focal

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --unsafe-perm

COPY . .

EXPOSE 10000

CMD ["node", "index.js"]

