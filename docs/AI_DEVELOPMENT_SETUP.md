# StdHub 跨设备 AI 开发环境

本文用于在新电脑、新 Codex 安装或会话清理后恢复 StdHub 的开发上下文。项目进度必须以仓库文件为准，不以聊天记录或某台电脑的个人配置为准。

## 1. 基础环境

安装以下工具：

- Git
- Node.js 20 或更高版本
- npm
- Python 3.8 或更高版本，仅 BW 验证码功能需要
- Codex 桌面版或支持 skills 的兼容代理环境

拉取项目后执行：

```powershell
npm install
npm run build
```

如需 BW 源验证码识别，再安装：

```powershell
pip install ddddocr
```

## 2. 安装项目使用的 skills

在新电脑的终端中逐条执行：

```powershell
npx skills add Leonxlnx/taste-skill
npx skills add alchaincyf/darwin-skill
npx skills add colbymchenry/codegraph
npx skills add greensock/gsap-skills
```

安装完成后重启 Codex，使新的 skill 清单重新加载。如果所用客户端提供 skills 列表，请确认至少能看到：

- `design-taste-frontend`
- `darwin-skill`
- CodeGraph 相关能力
- `gsap-core`
- `gsap-performance`
- `gsap-timeline`

这些 skills 的分工：

| Skill | 在本项目中的用途 |
|---|---|
| design-taste-frontend | 设计审计、视觉方向、反模板化检查和最终 pre-flight |
| CodeGraph | 仓库存在 `.codegraph/` 时优先定位符号、调用关系和影响范围 |
| GSAP skills | 约束少量复杂状态动效的实现、性能、清理和 reduced-motion |
| darwin-skill | 仅用于评估或优化 SKILL.md，不用于直接设计产品页面 |

## 3. CodeGraph 使用边界

仓库根目录存在 `.codegraph/` 时，理解或定位代码必须优先使用 CodeGraph，再使用文本搜索。仓库没有该目录时不要自行初始化，是否建立索引由项目维护者决定。

当前计划文件会记录此仓库在对应阶段是否存在 CodeGraph 索引。换电脑后应重新检查，不依赖旧电脑的状态。

## 4. 恢复工作上下文

每次开始新会话或换电脑后，按顺序执行：

1. 查看当前分支、最近提交和工作树状态。
2. 阅读 `task_plan.md`，确认 Current Phase 和第一个未完成项目。
3. 阅读 `progress.md`，确认最近实际改动和测试结果。
4. 阅读 `findings.md`，确认架构约束、视觉决策和已知问题。
5. 阅读 `docs/WHOLE_APP_UI_REDESIGN.md`，确认全站设计系统和页面验收规则。
6. 阅读 `docs/ARCHITECTURE.md` 和当前阶段涉及的专题文档。
7. 从当前阶段第一个未勾选项目继续，不重复已经完成的工作。

建议使用以下只读检查：

```powershell
git status --short
git log -5 --oneline
Get-Content -Raw task_plan.md
Get-Content -Raw progress.md
Get-Content -Raw findings.md
```

## 5. 进度更新规则

每完成一个可验收步骤，立即执行三项记录：

1. 在 `task_plan.md` 勾选项目，阶段结束时更新状态和 Current Phase。
2. 在 `progress.md` 记录修改文件、实际结果和运行过的测试。
3. 在 `findings.md` 记录新发现的约束、错误原因和不可重复的失败路径。

不要只在聊天中报告完成。跨设备恢复只能依赖已提交到仓库的文件。

## 6. 全站 UI 重构约束

- 保留原生 JavaScript 多脚本架构，不迁移框架。
- 保留路由、导航名称、字段顺序、元素 ID、接口和权限行为。
- PDF 阅读器已经完成，除全局视觉变量外不重写其业务逻辑。
- 默认不使用 GSAP。只有 CSS 无法清晰表达的连续状态变化才添加 GSAP。
- 不重新引入 Emoji 导航、紫色发光或背景装饰网格。
- Tabler 图标作为项目依赖安装，同时将浏览器需要的字体和 CSS 固定在 `public/vendor/tabler-icons/`，部署不依赖 CDN。
- Paper 是现代电脑的主验收主题，经典主题是老电脑兼容基线。页面改动必须先检查这两个主题，再检查深色和浅色。
- 经典主题的生产 CSS 必须保留 Chrome 109 可解析的颜色回退，不得把 color-mix、OKLCH 或 backdrop-filter 作为唯一声明。

## 7. 提交前检查

至少运行：

```powershell
npm run build
npm run css:check
npm test
```

涉及前端脚本时，对修改过的浏览器 JavaScript 运行语法检查。涉及布局时，检查桌面和移动端代表性页面，并将结果记录到 `progress.md`。
