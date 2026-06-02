# PI Agent Desktop / PI Agent 桌面版

A standalone desktop application wrapping the [PI coding agent](https://pi.dev) with a modern web UI — no browser, no terminal, just double-click and code.

将 PI 编程助手打包为独立的桌面应用，自带 Web UI，无需浏览器、无需终端，双击即用。

---

## Features / 功能

- **Standalone desktop app** — packaged with Electron, Node.js, and all dependencies into a single `PI-Agent.exe`
- **Persistent sessions** — chat history survives restarts, stored as JSONL in `.sessions/`
- **Session management** — resume, fork, delete, and export past conversations
- **Multi-provider LLM** — configure OpenAI, DeepSeek, Anthropic, and more with API keys
- **Dark theme UI** — clean, modern chat interface built with vanilla JS
- **Workspace switching** — change working directories from the UI

- **独立桌面应用** — 用 Electron 打包，内置 Node.js 和全部依赖，一个 `PI-Agent.exe` 文件即可运行
- **会话持久化** — 聊天记录重启不丢失，以 JSONL 格式存储在 `.sessions/` 目录
- **会话管理** — 恢复、分支、删除、导出历史对话
- **多模型支持** — 支持 OpenAI、DeepSeek、Anthropic 等多个 LLM 提供商
- **暗色主题 UI** — 简洁现代的聊天界面，纯 JS 实现
- **工作区切换** — 在 UI 中自由切换工作目录

---

## Quick Start / 快速开始

### Download / 下载

Download `PI-Agent.exe` from [Releases](../../releases) and double-click to run.

从 [Releases](../../releases) 下载 `PI-Agent.exe`，双击运行。

### Or build from source / 或从源码构建

```bash
# Clone the repo / 克隆仓库
git clone https://github.com/Jackzhangj2026/pi-agent-desktop.git
cd pi-agent-desktop

# Place pi.exe in the project root (or build from pi source)
# 将 pi.exe 放在项目根目录（或从 pi 源码构建）

# Install web UI dependencies / 安装 Web UI 依赖
cd web-ui
npm install

# Install Electron and build / 安装 Electron 并构建
cd desktop
npm install
npm run dist
```

The portable `PI-Agent.exe` will be in `desktop/dist/`.

打包好的 `PI-Agent.exe` 在 `desktop/dist/` 目录。

---

## Project Structure / 项目结构

```
pi-agent-desktop/
├── pi.exe                  # PI coding agent binary / PI 编程助手二进制
├── web-ui/
│   ├── server.js           # Express + WebSocket server / 服务端
│   ├── public/             # Frontend UI / 前端界面
│   ├── launch-pi-agent.bat # Quick launcher (Edge app mode) / 快速启动器
│   └── desktop/            # Electron wrapper / Electron 桌面壳
│       ├── main.js         # Electron main process / Electron 主进程
│       ├── preload.js      # Preload script / 预加载脚本
│       ├── package.json    # Build config / 构建配置
│       └── icon.ico        # App icon / 应用图标
└── .sessions/              # Chat history (JSONL) / 聊天记录
```

---

## Tech Stack / 技术栈

| Layer / 层 | Tech / 技术 |
|-------------|-------------|
| Desktop shell | Electron 35 |
| Backend server | Node.js + Express + WebSocket |
| Frontend | Vanilla JS + CSS |
| Coding agent | pi (Bun-compiled binary) |
| Packaging | electron-builder (portable) |

---

## License

MIT
