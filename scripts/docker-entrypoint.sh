#!/bin/bash
set -e

echo "[entrypoint] === 环境检查 ==="

# 检查 Python
if command -v python3 &> /dev/null; then
  echo "[entrypoint] Python3: $(python3 --version 2>&1)"
else
  echo "[entrypoint] ⚠ Python3 未安装，正在安装..."
  apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*
fi

# 检查 ddddocr
if python3 -c "import ddddocr" 2>/dev/null; then
  echo "[entrypoint] ddddocr: 已安装"
else
  echo "[entrypoint] ⚠ ddddocr 未安装，正在安装..."
  pip3 install --no-cache-dir --break-system-packages ddddocr
fi

# 检查 Node.js
if command -v node &> /dev/null; then
  echo "[entrypoint] Node.js: $(node -v)"
else
  echo "[entrypoint] ✗ Node.js 未找到"
  exit 1
fi

# 检查数据目录
for dir in data/standards data/exports data/backups; do
  mkdir -p "$dir"
done
echo "[entrypoint] 数据目录: OK"

# 检查编译产物
if [ ! -f "dist/src/index.js" ]; then
  echo "[entrypoint] ✗ dist/src/index.js 不存在，请先构建"
  exit 1
fi
echo "[entrypoint] 编译产物: OK"

echo "[entrypoint] === 环境检查通过，启动服务 ==="
exec node dist/src/index.js
