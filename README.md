# OpenLoop

> **The open-source, local-first client for self-evolving personal agents.**
>
> **面向持续进化个人 Agent 的开源、本地优先客户端。**

[**Download for macOS (Apple Silicon) / 下载 macOS DMG（Apple Silicon）**](https://github.com/SerienYang/OpenLoop/releases/latest/download/OpenLoop-macos-arm64.dmg)

<sub>macOS 12+ · Apple Silicon · Windows is on the way / Windows 版本正在路上</sub>

> Preview builds are currently unsigned. On first launch, right-click OpenLoop and choose **Open**.
>
> 当前预览版尚未正式签名。首次启动时，请右键点击 OpenLoop 并选择**打开**。
>
<img width="1236" height="618" alt="image" src="https://github.com/user-attachments/assets/28910826-c734-4ee8-a231-f2a7a6426b1d" />


OpenLoop is a local-first, open-source client for general-purpose task agents. It is not another chat window. It is a desktop runtime that can understand your projects, operate real tools, connect to external services, and carry work forward.

OpenLoop 是一个本地优先、开源的通用任务 Agent 客户端。它不只是另一个聊天窗口，而是一个可以理解你的项目、调用真实工具、连接外部服务并持续执行任务的桌面运行时。

OpenLoop's long-term direction is to let interaction data, task traces, and outcomes drive personalized capabilities and product iteration, always under explicit user authorization and control. Through real use, it is designed to learn how you work and evolve into a task system shaped around you.

OpenLoop 的长期方向是，在用户授权与控制下，让交互数据、任务轨迹和执行结果直接推动个性化能力与产品功能迭代。它会随着真实使用逐步理解你的工作方式，持续进化成更适合你的任务系统。

- **Evolves through use / 持续进化**: Real usage should drive capability development instead of keeping every user on the same fixed feature set.<br>让真实使用推动能力演进，而不是让所有用户停留在同一套固定功能中。
- **Local-first / 本地优先**: Sessions, configuration, and task state stay on your machine by default. Personalization should not require giving up control of your data.<br>会话、配置和任务状态默认保存在本机，个性化不以交出数据控制权为代价。
- **Open ecosystem / 开放生态**: Open-source, auditable, and extensible. OpenLoop does not lock you into one model, tool, or service provider.<br>开源、可审计、可扩展，不绑定单一模型、工具或服务商。
- **Built for tasks / 面向任务**: OpenLoop works across real projects, tool calls, approvals, and automations instead of stopping at generated answers.<br>围绕真实项目、工具调用、审批和自动化完成工作，而不是只生成答案。

Today, OpenLoop brings project sessions, models, connectors, approvals, scheduled tasks, and local execution into one client.

今天，OpenLoop 已经把项目会话、模型、连接器、审批、计划任务和本地执行放进同一个客户端。

Next, it should keep becoming more capable and more personal through real use.

下一步，是让这个客户端随着使用持续变得更适合你。

## Core capabilities / 核心能力

- **Project sessions / 项目会话**: Bind a session to a real project directory, read files, run commands, and save deliverables.<br>会话可以绑定真实项目目录，读取文件、执行命令并保存成果。
- **Local execution / 本地执行**: The agent runtime, conversation history, configuration, and task state stay local by default.<br>Agent、会话记录、配置和任务状态默认保存在本机。
- **Multiple model providers / 多模型接入**: Connect OpenAI, Anthropic, Gemini, OpenCode Go, OpenRouter, Ollama, and other supported providers.<br>支持 OpenAI、Anthropic、Gemini、OpenCode Go、OpenRouter、Ollama 等模型供应商。
- **Connectors and MCP / 连接器与 MCP**: Connect external services or load local and remote MCP tools.<br>可连接外部服务，也可以加载本地或远程 MCP 工具。
- **Human approval / 操作确认**: Require explicit approval before sending messages, changing external data, or running high-risk commands.<br>发送消息、修改外部数据和执行高风险命令前需要明确确认。
- **Pending inbox / 待处理事项**: Park actions that a background task cannot safely complete without user input.<br>后台任务无法安全完成的操作会进入待处理列表。
- **Desktop runtime / 桌面体验**: Run through a Tauri desktop shell with native macOS windows, system wake behavior, and local sidecars.<br>基于 Tauri，支持 macOS 原生窗口、系统唤醒策略和本地 sidecar。

## Architecture / 技术结构

```text
OpenLoop
├── React + TypeScript             Desktop interface / 桌面界面
├── Tauri + Rust                   Native shell and system APIs / 原生外壳与系统能力
├── Python + FastAPI               Agent, tools, models, connectors / Agent、工具、模型与连接器
├── SQLite + JSON                  Sessions, configuration, task state / 会话、配置与任务状态
└── Rust STT                       Local speech input / 本地语音输入
```

Main directories / 主要目录：

| Directory / 目录 | Purpose / 用途 |
|---|---|
| `openloop/` | Python agent runtime, tools, providers, connectors, MCP, persistence, and server<br>Python Agent runtime、工具、模型供应商、连接器、MCP、持久化与服务端 |
| `surfaces/gui/` | React interface, Tauri shell, and end-to-end tests<br>React 界面、Tauri 外壳和端到端测试 |
| `stt/` | Local speech-to-text sidecar<br>本地语音转文字 sidecar |
| `packaging/` | macOS build and packaging scripts; Windows support is under development<br>macOS 构建与安装脚本；Windows 支持仍在开发中 |
| `docs/` | Public configuration examples<br>公开配置示例 |
| `tests/` | Python backend tests<br>Python 后端测试 |

## Local development / 本地开发

Prerequisites / 环境要求：

- Python 3.10+
- Node.js 20+
- Rust 1.77+

Initialize the development environment / 初始化开发环境：

```shell
git clone https://github.com/SerienYang/OpenLoop.git
cd OpenLoop
bash packaging/setup_dev_env.sh
```

Run the backend / 启动后端：

```shell
.venv/bin/openloop-server --cwd ~/some/project --port 8765
```

Run the web interface / 启动浏览器界面：

```shell
cd surfaces/gui
npm install
npm run dev
```

Run the Tauri desktop app / 启动 Tauri 桌面应用：

```shell
cd surfaces/gui
npm run tauri dev
```

## Verification / 验证

Python tests / Python 测试：

```shell
.venv/bin/pytest
```

Frontend unit tests / 前端单元测试：

```shell
cd surfaces/gui
npm test
```

End-to-end tests / 端到端测试：

```shell
cd surfaces/gui
npm run e2e
```

Rust tests / Rust 测试：

```shell
cargo test --manifest-path surfaces/gui/src-tauri/Cargo.toml
cargo test --manifest-path stt/Cargo.toml
```

## Build and platform support / 构建与平台支持

OpenLoop currently supports local builds for macOS on Apple Silicon.

OpenLoop 当前支持 macOS（Apple Silicon）本地构建。

```shell
bash packaging/build_dmg.sh
```

Windows support is under development and validation. A supported Windows installer is not available yet.

Windows 版本仍在开发和验证中，目前不提供受支持的安装包。

## Data and privacy / 数据与隐私

OpenLoop stores sessions, project configuration, model configuration, and task state on your machine by default. When you use a cloud model or external connector, OpenLoop sends only the data needed to complete the request to services you explicitly configure.

OpenLoop 默认把会话、项目配置、模型配置和任务状态保存在本机。调用云端模型或外部连接器时，只会向用户主动配置的服务发送完成请求所需的数据。

Default state directories / 默认状态目录：

- macOS / Linux: `~/.config/openloop`
- Windows, planned / Windows 计划路径：`%APPDATA%\openloop`

Secrets and local environment files must never be committed to the repository.

密钥和本地环境文件不得提交到仓库。

## License / 许可证

OpenLoop is released under the [MIT License](LICENSE). You may use, modify, distribute, and commercialize the project, provided that the original copyright and license notices are retained. The software is provided as-is, without warranty.

OpenLoop 采用 [MIT License](LICENSE)。你可以自由使用、修改、分发和商业化本项目，但必须保留原版权及许可声明。软件按原样提供，不附带任何担保。
