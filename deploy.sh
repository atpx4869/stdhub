#!/bin/bash
# StdHub NAS 部署脚本
# 用法: bash deploy.sh
#
# 前提条件:
#   - Node.js >= 20
#   - Python >= 3.8 + pip install ddddocr（OCR 验证码识别）
#
# 部署后访问: http://<NAS-IP>:3000
# 如需 HTTPS 反代，在 nginx/caddy 中配置 proxy_pass 到 3000 端口

set -e

echo "=== StdHub NAS 部署 ==="

# 1. 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js >= 20"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "错误: Node.js 版本过低，需要 >= 20，当前: $(node -v)"
    exit 1
fi
echo "Node.js 版本: $(node -v)"

# 2. 检查 Python（OCR 可选）
if command -v python3 &> /dev/null; then
    echo "Python: $(python3 --version)"
    if ! python3 -c "import ddddocr" 2>/dev/null; then
        echo "安装 ddddocr..."
        pip3 install ddddocr || echo "警告: ddddocr 安装失败，OCR 功能不可用"
    fi
elif command -v python &> /dev/null; then
    echo "Python: $(python --version)"
else
    echo "警告: 未找到 Python，OCR 验证码识别功能不可用（非必须）"
fi

# 3. 安装依赖
echo "安装后端依赖..."
npm install --omit=dev

# 4. 编译 TypeScript
echo "编译 TypeScript..."
npm run build

# 5. 创建数据目录
mkdir -p data/standards data/exports data/backups

# 6. 启动
echo ""
echo "=== 部署完成 ==="
echo "访问地址: http://localhost:3000"
echo "如需 HTTPS 反代，请在 nginx 中配置:"
echo "  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }"
echo ""
node dist/src/index.js
