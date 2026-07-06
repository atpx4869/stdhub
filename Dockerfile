FROM node:20-slim

WORKDIR /app

# 安装系统依赖（better-sqlite3 编译 + ddddocr Python）
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 安装 ddddocr（OCR 验证码识别）
RUN pip3 install --no-cache-dir ddddocr || true

# 安装后端依赖
COPY package*.json ./
RUN npm ci

# 复制源码并编译
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# 复制前端和脚本
COPY public/ ./public/
COPY scripts/ocr_ddddocr.py ./scripts/

# 清理 devDependencies（减小镜像体积）
RUN npm prune --omit=dev

# 创建数据目录
RUN mkdir -p data/standards data/exports data/backups

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
