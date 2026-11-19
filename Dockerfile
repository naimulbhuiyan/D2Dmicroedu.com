FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY database ./database
RUN mkdir -p /app/server/data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/server.js"]
