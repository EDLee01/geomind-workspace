<div align="center">

<img src="./docs/assets/geomind-logo.png" width="300" alt="GeoMind — 面向科研人员的开源 AI 工作台" />

# GeoMind

**面向科研人员的开源 AI 工作台。** 你做严谨科研的研究伙伴。

一个开源、**本地优先**、**模型无关**、**可复现**的 AI 科研工作台——Claude Science
及同类 AI-for-Science 产品的开源替代。它不是聊天框：而是把文献、代码、图表、报告与
评审串成一条可审计、可复现工作流的工作台。

<p><a href="./README.md">English</a> · <b>中文</b></p>

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/version-v0.1-orange" alt="v0.1">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20React-24C8DB" alt="Built with Tauri + React">
  <img src="https://img.shields.io/badge/runtime-Magi-success" alt="Magi runtime">
  <a href="http://makeapullrequest.com"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <a href="https://linux.do"><img src="https://img.shields.io/badge/Join-linux.do-orange" alt="linux.do"></a>
</p>

</div>

---

## 目录

- [✨ 与众不同之处](#-与众不同之处)
- [🎬 效果演示](#-效果演示)
- [🧭 工作原理](#-工作原理)
- [🧪 核心能力](#-核心能力)
- [🔌 技能与连接器](#-技能与连接器)
- [🚀 快速开始](#-快速开始)
- [💬 如何使用](#-如何使用)
- [🔒 安全与隐私](#-安全与隐私)
- [🗂️ 仓库结构](#️-仓库结构)
- [📌 状态与路线图](#-状态与路线图)
- [🤝 参与贡献](#-参与贡献)
- [⚖️ 许可证](#-许可证)
- [🙏 致谢](#-致谢)

## ✨ 与众不同之处

- **工作台，而非聊天框** —— 规划 → 批准 → 执行 → 产出工件 → 评审。
- **可追溯的工件，不只是文字** —— 每一张图、每一张表、每一份报告都能溯源到生成它的
  代码、数据、环境，以及对应的那段对话。
- **本地优先** —— 你的数据与算力留在本机；应用会清楚说明有什么（若有）会离开设备。
- **模型无关** —— 通过 OpenRouter、OpenAI 兼容、Anthropic 或本地模型自带密钥；也内置
  一个开箱即用、零配置的免费模型。
- **可复现** —— 代码、数据、图表、报告、日志与 `provenance.jsonl` 全部保留，且每个
  工件版本都可回溯。
- **多学科** —— 从 AI4S 起步，逐步扩展到地球科学、材料、化学与工程。

## 🎬 效果演示

**一句提示 → 一份完整、可追溯的分析。** 模拟数据、拟合模型、保存出版级图表，并写出一份
每个数字都能溯源到代码的报告。

![端到端剂量-响应分析：智能体运行代码，产出拟合图与报告](./docs/assets/showcase-workflow.webp)

**每个工件都能回溯到它的代码、输入与对话** —— 在图上一键点开，就能看到生成它的脚本
以及背后的历史版本。

![工件检查器展示某张图的生成代码、输入与溯源信息](./docs/assets/showcase-provenance.webp)

**文献 → 可验证的报告。** 检索论文、起草并渲染为 PDF 的稿件，并对其做引用、无出处数字、
图↔代码一致性的审计。

![文献综述产出渲染后的 PDF 稿件，并附带可追溯性评审](./docs/assets/showcase-literature.webp)

<details>
<summary><b>更多截图</b> —— 笔记本、实验扫描与技能库</summary>

<br>

**对话优先的笔记本。** 智能体驱动真实的 Jupyter 内核；单元格与图表在聊天旁实时出现。

![智能体驱动 Jupyter 笔记本并实时绘制 matplotlib 图](./docs/assets/showcase-notebook.webp)

**运行并跟踪实验。** 扫描参数、保持常驻内核，并把结果作为可追溯工件呈现。

![实验扫描表格与实时分析笔记本并列](./docs/assets/showcase-experiment.webp)

**可插拔的科学技能。** 内置文献、实验、绘图与学术诚信技能——外加一键开源连接器与自接工具。

![技能库列出内置的科学技能](./docs/assets/showcase-skills.webp)

</details>

## 🧭 工作原理

```
你的提示
   │
   ▼
[ 规划 ] ──▶ [ 批准 ] ──▶ [ 执行 ]              本地 Python / Jupyter 内核、
   ▲            ▲            │                  shell、MCP 工具 —— 都在你的机器上
   │            │            ▼
   │        你回答问题 /  [ 工件 ]  ──▶  图 · 表 · 笔记本 · 报告
   │        授予权限         │                  每个都关联到代码 + 数据 + 环境
   │                        ▼
   └───────────────────  [ 评审 ]        引用审计 · 无出处数字标记 ·
                                          图 ↔ 代码一致性
```

一切都经由内置的 [Magi](https://github.com/EDLee01/magi) 智能体运行时（一个 Node 进程，
由应用固定版本并管理，运行在应用私有端口上）。UI 从不直接与模型对话——它通过一层轻量 SDK
（`MagiClient`），因此技能、MCP 服务器与模型提供方都保持可插拔。

## 🧪 核心能力

| 能力 | 说明 |
|---|---|
| **完整工作流** | 一句提示驱动 数据 → 代码 → 图表 → 报告 → 可复现记录。一键启动卡助你上手。 |
| **本地计算** | 常驻的本地 Python 内核，以及可选的隔离 Jupyter 环境（用内置 `uv` provision——不动你系统的 Python）。 |
| **工件溯源** | 智能体每次写文件都会向 `.openscience/provenance.jsonl` 追加版本记录；History 面板展示每个版本的代码、模型与来源对话。 |
| **可追溯评审员** | 解析引用（Crossref / arXiv / PubMed）、标记无出处的数字、核对图与生成它的代码是否一致。 |
| **原生查看器** | 内联渲染 PDF、表格、图片、HTML 与 Office 文档；matplotlib/plotly 图默认即出版级。 |
| **统一设计系统** | 一套经校验的图表色板，原生 UI 与智能体生成的 matplotlib 图共用——明暗模式都正确。 |
| **键盘优先** | 命令面板（⌘K）可达每一个主操作。 |
| **模型选择** | 通过 `config.yaml` 的模型别名（`main` / `fast` / `deep` / …）自带密钥，解析到任意已配置的提供方——Anthropic、OpenAI 兼容端点、DeepSeek/硅基流动、Gemini 等。 |

## 🔌 技能与连接器

**内置科学技能**（应用随附并保持同步的智能体“操作手册”）：

- `research-explorer`、`literature-survey`、`experiment-suite`、`paper-writer`、
  `mindmap-render`、`integrity-auditor`、`ai4s-agent` —— 即
  [ai4s-skills](https://github.com/ai4s-research/ai4s-skills) 技能包。
- `traceability-review` 与 `publication-figures` —— 用于可验证评审与出版级图表的
  第一方技能。

**一键开源连接器**（用内置 `uv` provision 到隔离环境）：

- **文献** —— arXiv、PubMed、Crossref、Semantic Scholar、bioRxiv/medRxiv
  （[paper-search-mcp](https://github.com/openags/paper-search-mcp)）。
- **材料** —— Materials Project 材料属性、晶体结构、相图。
- **经济** —— FRED 经济时间序列。

**自接工具** —— 任意 MCP 服务器（本地命令或远程 URL）或技能；参见
[`docs/CONNECT_YOUR_TOOLS.md`](./docs/CONNECT_YOUR_TOOLS.md)。

## 🚀 快速开始

> **前置依赖：** [Node.js](https://nodejs.org) ≥ 20、[pnpm](https://pnpm.io) 9，以及
> [Rust 工具链](https://rustup.rs)（Tauri 需要）。macOS 或 Windows。

从源码构建桌面应用：

```bash
git clone https://github.com/EDLee01/geomind-workspace
cd geomind-workspace
pnpm install

# 拉取固定版本的运行时与内置技能（不纳入 git）：
bash scripts/dev/fetch-magi.sh    # Magi 智能体运行时（Node + npm 包）
bash scripts/dev/fetch-uv.sh         # uv，用于隔离的 Python/Jupyter 环境
bash scripts/dev/fetch-skills.sh     # ai4s-skills 技能包

# 开发调试，或构建安装包（.dmg / .app / NSIS / .msi）：
pnpm --filter @ai4s/desktop tauri dev
pnpm --filter @ai4s/desktop tauri build
```

首次启动时，应用会自动拉起内置运行时，并用免费模型开箱即用——随时可在 **设置** 里换成
你自己的提供方。

常用检查：

```bash
pnpm test        # 单元测试（Vitest）
pnpm typecheck   # TypeScript
pnpm lint        # ESLint
```

## 💬 如何使用

- **从工作流开始** —— 空会话提供一键启动卡（跑演示分析、分析你的数据、审计报告），
  也可以直接输入你想做的事。
- **需要时作答** —— 智能体要做决定时会带选项在对话内询问；要运行命令或写文件时会请求
  权限（允许一次 / 始终允许 / 拒绝）。默认为手动批准。
- **检查任意工件** —— 点击图表、报告或笔记本在右侧面板打开；打开它的 **History** 查看
  每个版本，并跳回生成它的那段对话。
- **⌘K 直达一切** —— 命令面板可运行每一个主操作。
- **添加数据** —— 把文件放进工作区（`~/Documents/OpenScience`），或在输入框里附加；
  智能体在那里读写。

## 🔒 安全与隐私

- **默认本地** —— 你的工作区文件、原始数据、代码执行、会话历史与溯源记录都留在本机。
  设置里用大白话说明：发给你所选模型提供方的到底是什么（你的消息，以及智能体为完成任务
  所读取的文件/命令输出），以及什么永远不会离开。
- **人在环中** —— 命令执行、删除文件、安装依赖与远程连接都需批准；应用以手动批准模式发布。
- **凭据** —— 提供方密钥存放在应用私有文件中，绝不进入工作区、溯源、日志或导出。

## 🗂️ 仓库结构

| 路径 | 用途 |
| --- | --- |
| `apps/desktop/` | Tauri 2 + React + TypeScript + Vite 桌面外壳（`src/` 前端，`src-tauri/` Rust） |
| `packages/shared/` | 共享领域类型与图表设计系统 |
| `packages/sdk/` | `MagiClient` SDK 封装（将 UI 与运行时隔离） |
| `packages/ui/` | 共享 UI 组件库 |
| `runtime/skills/core/` | 第一方科学技能（`traceability-review`、`publication-figures`） |
| `runtime/skills/external/` | 内置的 `ai4s-skills` 技能包（脚本拉取） |
| `runtime/` | `manager`、`mcp`、`kernel` 配置（外加一个来自迁移前运行时的遗留 `opencode-profile/`） |
| `docs/` | `PRD.md`、`TECHNICAL_DESIGN.md`、`REQUIREMENTS.md`、`CONNECT_YOUR_TOOLS.md` |
| `examples/climate-trends/` | 内置的端到端示例项目工作区 |
| `scripts/` | `release/` 与 `dev/` 脚本（sidecar 与技能拉取器） |

## 📌 状态与路线图

`v0.1`，积极开发中——macOS 上可用的桌面 MVP。日志见 [`PROGRESS.md`](./PROGRESS.md)，
完整规格见 [`docs/REQUIREMENTS.md`](./docs/REQUIREMENTS.md) / [`docs/PRD.md`](./docs/PRD.md)。

- ✅ 端到端工作流、工件溯源、可追溯评审员、本地 Python 内核 + Jupyter、一键科学连接器、
  大白话数据流说明、图表设计系统、命令面板。
- 🚧 下一步：领域渲染器（蛋白 / 化学结构）、R 内核、Windows 安装包、更大的多文件工程，
  以及 HPC / Slurm 计算。

## 🤝 参与贡献

欢迎提交 Issue 与 PR。请保持改动最小且可验证，遵循 [`AGENTS.md`](./AGENTS.md) 中的设计
原则（简单 · 明确 · 清晰 · 完整），并在提 PR 前跑通 `pnpm test`、`pnpm typecheck`、
`pnpm lint`。

## ⚖️ 许可证

[MIT](./LICENSE)。随附的第三方科学技能与连接器各自遵循其自身许可证。

> 这是 beta 阶段的科研工具。产出均为草稿——请核实数字、引用与结论，并在任何投稿或决策
> 前交由领域专家评审。

## 🙏 致谢

GeoMind 是 [Open Science](https://github.com/ai4s-research/open-science)（MIT 许可）的
一个分叉——原始工作台的设计与代码由 AI4S Workbench contributors 完成，其版权保留在
[LICENSE](./LICENSE) 中。本分叉将其重新命名为 GeoMind 并适配了运行时。

基于 [Tauri](https://tauri.app)、[Magi](https://github.com/EDLee01/magi) 智能体运行时与
[ai4s-skills](https://github.com/ai4s-research/ai4s-skills) 技能包构建。感谢
[linux.do](https://linux.do) —— 一个充满活力的技术社区，本项目在此分享与讨论。
