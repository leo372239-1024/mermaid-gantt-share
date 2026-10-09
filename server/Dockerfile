FROM node:22-alpine

WORKDIR /app

# 只有一个运行时依赖（pg）。用国内镜像源，避免构建时卡在 registry.npmjs.org。
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com

COPY . ./

ENV NODE_ENV=production
EXPOSE 18080

# 静态资源目录由 compose 挂载为 /site（只读）；这里只放服务代码。
CMD ["node", "index.js"]
