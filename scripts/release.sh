#!/bin/bash
# 自动创建 GitHub Release 脚本
# 用法: bash scripts/release.sh
#
# 功能:
# 1. 从 package.json 读取版本号
# 2. 创建 git tag (如果不存在)
# 3. 推送 tag 到远程
# 4. 创建 GitHub Release

set -e

# 读取版本号
VERSION=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ]; then
    echo "错误: 无法从 package.json 读取版本号"
    exit 1
fi

TAG="v$VERSION"
echo "=== 创建 Release $TAG ==="

# 检查 tag 是否已存在
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "Tag $TAG 已存在，跳过创建"
else
    echo "创建 tag $TAG..."
    git tag -a "$TAG" -m "Release $TAG"
fi

# 推送 tag
echo "推送 tag 到远程..."
git push origin "$TAG"

# 检查 release 是否已存在
if gh release view "$TAG" >/dev/null 2>&1; then
    echo "Release $TAG 已存在，跳过创建"
    exit 0
fi

# 获取上一个版本 tag（只匹配 v* 格式）
PREV_TAG=$(git tag -l 'v*' --sort=-v:refname | head -n1 2>/dev/null || echo "")

# 生成更新日志
echo "生成更新日志..."
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TAG" ]; then
    NOTES=$(git log "$PREV_TAG..HEAD" --pretty=format:"- %s" --no-merges)
else
    NOTES=$(git log --pretty=format:"- %s" --no-merges -20)
fi

# 创建 release
echo "创建 GitHub Release..."
gh release create "$TAG" \
    --title "StdHub $TAG" \
    --notes "## StdHub $TAG

### 更新内容
$NOTES

### 安装
- 下载对应平台的安装包
- 或使用 Docker 部署: docker compose up -d

### 文档
- GitHub 仓库: https://github.com/atpx4869/stdhub
- 更新日志: https://github.com/atpx4869/stdhub/releases"

echo ""
echo "=== Release $TAG 创建成功 ==="
echo "查看: https://github.com/atpx4869/stdhub/releases/tag/$TAG"
