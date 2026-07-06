# ── Stage 1: 构建 ──
FROM node:20-slim AS builder

WORKDIR /app

# 编译工具（仅构建阶段需要）
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: 运行时 ──
FROM node:20-slim

WORKDIR /app

# 运行时依赖：Python（ddddocr）+ 编译工具（better-sqlite3 native addon）
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    make g++ \
    && rm -rf /var/lib/apt/lists/*

# 安装 ddddocr（含 numpy/opencv，约 200MB）
RUN pip3 install --no-cache-dir --break-system-packages ddddocr \
    && pip3 cache purge 2>/dev/null || true

# 复制构建产物（不带 node_modules 源码）
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 编译完成，移除构建工具（减小约 200MB）
RUN apt-get purge -y make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# 复制静态资源
COPY public/ ./public/
COPY scripts/docker-entrypoint.sh ./scripts/
COPY scripts/ocr_ddddocr.py ./scripts/
RUN chmod +x scripts/docker-entrypoint.sh

RUN mkdir -p data/standards data/exports data/backups

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["scripts/docker-entrypoint.sh"]
