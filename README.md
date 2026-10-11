<div align="center">

# dsh-plugin-wbrelay

**面向 dsh 的 CodeBuddy CLI 模型桥接插件**

![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)

[项目原理](#项目原理) · [安装与加载](#安装与加载) · [插件看板](#插件看板) · [模型能力](#模型能力)

</div>

---

## 项目简介

`dsh-plugin-wbrelay` 为 dsh 提供基于 CodeBuddy CLI 的本地模型桥接能力。插件将 dsh 的模型请求交给本机 wbrelay 服务，再由 wbrelay 转发到 CodeBuddy 上游路由。

插件包含以下部分：

- dsh bundle 配置与 `wbrelay` 模型提供方
- 可拖动的悬浮按钮和内嵌状态看板
- 本地桥接服务及服务编排器
- CLI 登录、授权捕获和状态查询接口
- 上游模型清单与原生推理等级同步

本项目是独立的第三方插件，不代表 dsh、CodeBuddy 或其关联服务的官方立场。

## 插件标识

| 用途 | 标识 |
| --- | --- |
| 插件包名与 bundle ID | `dsh-plugin-wbrelay` |
| dsh 模型提供方 | `wbrelay` |
| 看板按钮 | `wbrelay` |
| 本地桥接端口 | `8790` |

## 项目原理

```text
dsh
  │
  └─ OpenAI 兼容请求
       │
       ▼
http://127.0.0.1:8790/v1
       │
       ▼
wbrelay 本地桥接
       │
       ├─ 请求转换与流式响应适配
       ├─ 模型路由与推理等级传递
       └─ 状态、统计和错误信息
       │
       ▼
CodeBuddy 上游模型服务
```

CodeBuddy CLI 负责会话登录和授权。捕获代理在本机终结目标连接，读取授权元数据并写入运行时目录，桥接服务使用最新授权信息访问上游。授权内容只在本机运行链路中流转，不通过 dsh 看板展示。

桥接服务使用 `127.0.0.1` 回环地址，默认端口为 `8790`。CLI 服务和捕获代理分别使用 `60622` 与 `443` 端口。插件看板通过 dsh web server 路由调用这些服务，不依赖桌面端窗口保持打开。

## 功能概览

| 功能 | 说明 |
| --- | --- |
| 模型桥接 | 将 dsh 的 OpenAI 兼容请求转换并转发到 CodeBuddy 上游 |
| 内嵌看板 | 在 dsh 界面内显示运行状态，按钮位置可拖动并持久化 |
| CLI 状态 | 显示 CLI 服务、登录状态和运行状态 |
| 登录唤醒 | 从看板打开带本机捕获环境的 CodeBuddy CLI 窗口 |
| 捕获管理 | 查询 443 捕获代理与 hosts 状态，并通过 UAC 启用 hosts 映射 |
| Token 时间戳 | 展示签发时间、过期时间、最近捕获时间和剩余有效期 |
| 路由模型 | 拉取上游模型清单，显示每个模型的推理能力 |
| 原生推理等级 | 将已确认的模型能力同步到 dsh 原生推理等级菜单 |
| 运行监控 | 展示桥接端口、引擎、运行时长、请求统计和最近错误 |

## 环境要求

- Windows
- Node.js `>=18`
- Git
- pnpm
- 可加载 bundle 插件的 dsh
- CodeBuddy CLI 及可用登录账号
- 能够执行 hosts 修改的管理员权限
- 本机生成的捕获代理证书

## 安装与加载

### 从 dsh 插件页安装

1. 打开 dsh 的 **插件** 页面，选择 **添加插件**。
2. 在安装地址中粘贴仓库地址：

   ```text
   https://github.com/Q-998/dsh-plugin-wbrelay
   ```

3. 完成安装后选择 **立即启用**。若当前 profile 不支持热重载，重启 dsh 使插件生效。

dsh 插件管理器会从 GitHub 获取插件包、注册 bundle，并将其加入当前 profile；无需手动编辑 profile 配置。

### 使用 Git 克隆

也可以先克隆仓库，再从 dsh 插件页添加本地目录：

```powershell
git clone https://github.com/Q-998/dsh-plugin-wbrelay.git
Set-Location dsh-plugin-wbrelay
$PWD.Path
```

将命令输出的完整目录路径填入 **添加插件**，安装后选择 **立即启用**。

### 运行时证书

捕获代理使用设备专用 CA 和目标服务证书完成本机 TLS 终结。证书由部署设备自行生成，运行时文件位于 `channel/mitm`，并由 `.gitignore` 排除。证书材料不属于插件配置，也不进入 Git 历史。

## 插件看板

点击 dsh 中的 `wbrelay` 按钮展开看板，拖动按钮可以改变位置。看板通过插件路由执行后续流程，状态数据来自本机服务探测和模型能力接口。

### 看板工作流

1. **启动通道**
   看板调用插件启动路由，编排器按顺序检查并拉起 CLI 服务、捕获代理和 wbrelay 桥接服务。

2. **启用 hosts 捕获**
   看板调用管理员修复路由，系统弹出 UAC 确认窗口。确认后，目标域名解析到本机捕获代理。

3. **唤醒 CLI 登录**
   看板打开继承本机捕获证书环境的 CodeBuddy CLI 窗口。CLI 完成登录后发起一次上游请求，捕获代理记录授权元数据。

4. **刷新 Token 状态**
   看板读取运行时授权文件的时间字段和 JWT 时间字段，只显示时间戳与有效期，不显示授权内容。

5. **拉取路由模型**
   看板查询 `/v1/models`，展示当前路由模型和模型能力来源。模型能力可来自 CLI 返回的能力声明或已加载的路由配置。

6. **同步原生推理等级**
   插件根据 CLI 返回的模型能力更新 dsh 的 `reasoningEfforts`。dsh 原生“推理等级”菜单随后显示模型实际支持的档位。

7. **发送模型请求**
   dsh 继续使用 `wbrelay` 提供方。用户选择的模型和推理等级通过本地桥接传递到上游，流式思考内容与正文保持独立的响应结构。

看板状态优先读取桥接服务，桥接服务不可达时回退到插件状态接口。状态暂不可确认时，界面保留上次模型列表并标记当前状态。

## 模型能力

插件自带的 `cordis.patch.yml` 提供 `wbrelay` 模型提供方和默认模型：

| 配置项 | 默认值 |
| --- | --- |
| 提供方 | `wbrelay` |
| API 类型 | `openai-completions` |
| Base URL | `http://127.0.0.1:8790/v1` |
| 默认模型 | `glm-5.3-flash` |
| 请求头 | `x-wb-session: dsh` |

模型列表由路由配置和 `/v1/models` 返回结果共同决定。模型能力同步只更新指向本机 wbrelay 桥的模型，不修改其他提供方、凭据、地址或兼容参数。

### 原生推理等级原理

CodeBuddy 上游模型的能力声明会被转换为 dsh 模型配置中的 `reasoningEfforts`。用户在 dsh 中选择的档位随后以请求参数传递给 wbrelay，再由桥接服务转换为上游所需的推理强度字段。

支持的档位由模型动态决定，常见值包括：

```text
minimal  low  medium  high  xhigh  max
```

模型不支持思考时不会写入推理档位。模型强制开启思考时，dsh 原生菜单不显示关闭选项。同步服务定期刷新能力清单，并使用配置版本号避免覆盖用户同时进行的其他设置变更。

## 插件路由

| 方法 | 路由 | 作用 |
| --- | --- | --- |
| `GET` | `/dsh-plugin-wbrelay/status` | 查询桥接、CLI、hosts、捕获代理和 Token 时间戳 |
| `GET` | `/dsh-plugin-wbrelay/models` | 返回模型清单和原生推理同步状态 |
| `POST` | `/dsh-plugin-wbrelay/models/refresh` | 强制刷新模型清单与能力 |
| `POST` | `/dsh-plugin-wbrelay/start` | 启动本地服务 |
| `POST` | `/dsh-plugin-wbrelay/restart` | 重启本地服务 |
| `POST` | `/dsh-plugin-wbrelay/fix-hosts` | 通过管理员授权启用 hosts 捕获 |
| `POST` | `/dsh-plugin-wbrelay/open-cli` | 打开 CodeBuddy CLI 登录窗口 |
| `GET` | `/dsh-plugin-wbrelay/dashboard` | 打开独立诊断页面 |

## 项目结构

| 文件 | 用途 |
| --- | --- |
| `client.js` | dsh 悬浮按钮、拖动逻辑和内嵌看板 |
| `lib/index.js` | 插件路由、状态查询、服务启动和登录唤醒 |
| `lib/native-reasoning.js` | 模型能力查询与 dsh 原生推理同步 |
| `cordis.patch.yml` | dsh provider、模型和 bundle 配置 |
| `channel/orchestrator.cjs` | 本地服务编排器 |
| `channel/dsh-wb-bridge.cjs` | 模型桥接、请求转换和状态统计 |
| `channel/mitm/tls-capture-443.cjs` | TLS 捕获代理和授权元数据更新 |
| `channel/mitm/san.cnf` | 设备证书签发使用的 SAN 配置 |

## 安全边界

设备证书、私钥、授权文件、运行日志、推理设置、dsh profile、CLI profile、会话内容和缓存均属于本机运行数据，不进入版本控制。

`.gitignore` 覆盖以下运行时类型：

```text
channel/mitm/captured-token.json
channel/mitm/*.key
channel/mitm/*.pem
channel/runtimes.json
channel/reasoning-settings.json
*.log
```

桥接服务和 CLI 服务默认只监听本机回环地址。对外发布仓库时，Git 索引中只包含源代码、配置模板和文档。

## 停用与卸载

停止使用时，由看板关闭捕获通道并恢复 hosts 设置，再从 dsh profile 的依赖和 bundle 列表移除 `dsh-plugin-wbrelay`。卸载插件不会删除 CodeBuddy 账号或其他 dsh 配置。本机证书、授权文件和运行日志按设备策略单独清理。

## 许可证

本项目采用 MIT License。
