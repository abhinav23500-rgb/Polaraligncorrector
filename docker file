FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends astap-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
EXPOSE 3000

CMD ["npm", "start"]
