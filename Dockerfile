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

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    XDG_CACHE_HOME=/tmp/.cache \
    HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1

# 系统依赖：
# - python3 + pip: ddddocr OCR 验证码识别
# - make + g++: better-sqlite3 native addon 编译
# - Chromium 系统库: Playwright headless 浏览器（CNAS 爬虫）
# - libvips: sharp 图片处理
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    make g++ \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libvips42 \
    && rm -rf /var/lib/apt/lists/*

# ddddocr OCR（含 numpy/opencv）
RUN pip3 install --no-cache-dir --break-system-packages ddddocr \
    && pip3 cache purge 2>/dev/null || true

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Playwright Chrome（CNAS 爬虫需要）
# 注意：channel:'chrome' 用 Google Chrome（/opt/google/chrome/chrome），不是 Playwright 自带
# Chromium。`install-deps chrome` 对 chrome channel 无效（其 _dependencyGroup 未定义，
# 只装 tools 组），Chrome 自身的 .deb 依赖树 + 上方 apt-get 的 libnss3/libgbm1 等
# 已覆盖全部系统依赖，无需再跑 install-deps。
RUN mkdir -p /ms-playwright \
    && npx playwright install chrome \
    && rm -rf /ms-playwright/downloads /root/.cache/ms-playwright/downloads 2>/dev/null || true

# 移除编译工具（减小镜像）
RUN apt-get purge -y make g++ && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# 静态资源 + 入口脚本 + OCR 脚本
COPY public/ ./public/
COPY scripts/docker-entrypoint.sh ./scripts/
COPY scripts/ocr_ddddocr.py ./scripts/
RUN chmod +x scripts/docker-entrypoint.sh

RUN groupadd --system stdhub \
    && useradd --system --gid stdhub --home-dir /home/stdhub --create-home stdhub \
    && mkdir -p data/standards data/exports data/backups standards /tmp/.cache \
    && chown -R stdhub:stdhub /app/data /app/standards /home/stdhub /tmp/.cache /ms-playwright

USER stdhub

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["scripts/docker-entrypoint.sh"]
