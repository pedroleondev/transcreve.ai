FROM node:20-alpine

WORKDIR /app

# T-11: ffmpeg extrai áudio de vídeo; yt-dlp baixa YouTube/Vimeo para transcrição por link.
RUN apk add --no-cache ffmpeg yt-dlp

COPY package*.json ./

RUN npm ci --only=production

COPY . .

RUN mkdir -p uploads

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
