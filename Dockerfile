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

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
