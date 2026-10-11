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
| 捕获证书 | 自动生成、自检并续期本机证书，展示到期时间、剩余天数与指纹 |
| 斜杠命令 | `/wbrelay start` 一键启动通道、`/wbrelay status` 查看状态、`/wbrelay delete` 卸载插件 |
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
- 本机生成的捕获代理证书（首次启动通道时自动生成，也可用 `gen-certs.cmd` 手工生成）

## 安装与加载

### 从 dsh 插件页安装

1. 打开 dsh 的 **插件** 页面，选择 **添加插件**。
2. 在窗口顶部的 **插件包名、GitHub 仓库地址或本地目录路径** 输入框中粘贴插件归档地址：

   ```text
   https://github.com/Q-998/dsh-plugin-wbrelay/archive/refs/heads/main.tar.gz
   ```

3. **安装源**仅用于选择 npm 注册表。安装 GitHub 归档时保持默认选项，不要把 GitHub 地址填入“自定义地址”。
4. 点击安装，完成后选择 **立即启用**。**首次安装必须重启 dsh**：dsh 的 HMR 只热重载 profile 配置，
   新加入的模块根（也就是本插件）要等下一次启动才会被加载——所以重启之前 `/wbrelay` 命令和面板按钮都不会出现。
   重启后若面板按钮仍未出现，刷新一次页面（客户端 bundle 在页面加载时装配）。

dsh 插件管理器会从 GitHub 获取归档、注册 bundle，并将其加入当前 profile；无需手动编辑 profile 配置。

| 安装入口 | 管理器行为 | 何时用 |
| --- | --- | --- |
| `https://github.com/Q-998/dsh-plugin-wbrelay` | 先执行 `git ls-remote` 连接检查，失败即中止安装 | 能稳定访问 github.com 时 |
| `https://github.com/Q-998/dsh-plugin-wbrelay/archive/refs/heads/main.tar.gz`（或 `…/archive/refs/tags/v1.0.2.tar.gz`） | 直接按 URL 拉归档，**不做连接检查** | 连接检查失败时的首选 |
| 本地目录路径（先 `git clone`） | 直接使用本地目录，不联网 | GitHub 完全不可达或离线 |

连接检查失败的日志在 `<profile>\.plugin-manager\logs\github-connection-*\git.log`，典型原因是
`github.com:443` 不可达（`Connection was reset`、`Failed to connect … port 443`），而 `api.github.com`、
`raw.githubusercontent.com` 仍可用——这种情况下改用归档地址或本地目录即可，不必等网络恢复。

### 使用 Git 克隆

> **入口区别：** dsh 的插件输入框不是命令行，不能粘贴 `git clone ...` 命令。直接安装时粘贴上面的归档 URL；
> 使用 Git 安装时，先在 Windows CMD 中逐条执行下面的命令，最后只把本地项目目录路径粘贴回 dsh。

如果希望通过本地仓库安装，请按以下步骤操作。命令适用于 Windows **命令提示符（CMD）**，每一步单独执行。

1. 打开 CMD，切换到希望存放仓库的目录。以下示例使用当前 Windows 用户目录：

   ```cmd
   cd /d %USERPROFILE%
   ```

   `%USERPROFILE%` 会由 Windows 替换为当前用户目录；`/d` 允许同时切换盘符。

2. 克隆 GitHub 仓库：

   ```cmd
   git clone https://github.com/Q-998/dsh-plugin-wbrelay.git
   ```

   Git 会在当前目录下创建 `dsh-plugin-wbrelay` 文件夹并下载项目文件。

   克隆完成后，本地项目目录就是 `%USERPROFILE%\dsh-plugin-wbrelay`。在 dsh **添加插件**窗口顶部的
   **插件包名、GitHub 仓库地址或本地目录路径** 输入框中粘贴该路径，完成安装后选择 **立即启用**。

### 设备证书

捕获代理要用本机自签证书终结 `copilot.tencent.com` 的 TLS，CLI 通过 `NODE_EXTRA_CA_CERTS` 信任这张 CA。
证书属于设备专用材料：不进版本控制、不随插件分发，由插件在部署设备上生成。

以下入口都会自动确保证书可用（缺失、过期、主机名不覆盖、公私钥不配对均会重签）：

- 启动通道（`channel/dsh-channel.cmd` 或看板「启动通道」）
- 443 捕获代理自身启动时自检
- 看板「捕获证书」区的「生成证书 / 重新生成证书」
- 打开 CLI 登录窗口之前

需要手工处理时（不需要管理员权限）：

```powershell
.\channel\mitm\gen-certs.cmd            # 确保存在且有效
.\channel\mitm\gen-certs.cmd --force    # 强制重签
.\channel\mitm\gen-certs.cmd --status   # 只检查，不写文件
```

两种等价引擎任选：内置生成器只要 Node.js（默认，纯 `node:crypto` 现场签发），
`--engine openssl` 则执行下面这套手工命令。

```powershell
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 `
  -keyout ca.key -out ca.pem -subj "/CN=dsh-mitm-ca"

openssl req -newkey rsa:2048 -nodes `
  -keyout srv.key -out srv.csr -subj "/CN=copilot.tencent.com"

openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial `
  -out srv.pem -days 3650 -extfile san.cnf
```

生成文件为 `ca.key`、`ca.pem`、`srv.key` 和 `srv.pem`，位于 `channel/mitm`；`srv.csr` 与 `ca.srl`
是一次性中间产物，签发后可删除。SAN、有效期、续期阈值、重新生成时机和排错见
[channel/mitm/CERT.md](channel/mitm/CERT.md)。

## 插件看板

点击 dsh 中的 `wbrelay` 按钮展开看板，拖动按钮可以改变位置。看板通过插件路由执行后续流程，状态数据来自本机服务探测和模型能力接口。

### 看板工作流

1. **启动通道**
   看板调用插件启动路由，编排器先确保证书可用，再按顺序检查并拉起 CLI 服务、捕获代理和 wbrelay 桥接服务。

2. **准备设备证书**
   证书缺失或不合格时自动生成；看板「捕获证书」区显示到期时间、剩余天数和指纹，可一键重新生成。

3. **启用 hosts 捕获**
   看板调用管理员修复路由，系统弹出 UAC 确认窗口。确认后，目标域名解析到本机捕获代理。

4. **唤醒 CLI 登录**
   看板打开继承本机捕获证书环境的 CodeBuddy CLI 窗口。CLI 完成登录后发起一次上游请求，捕获代理记录授权元数据。

5. **刷新 Token 状态**
   看板读取运行时授权文件的时间字段和 JWT 时间字段，只显示时间戳与有效期，不显示授权内容。

6. **拉取路由模型**
   看板查询 `/v1/models`，展示当前路由模型和模型能力来源。模型能力可来自 CLI 返回的能力声明或已加载的路由配置。

7. **同步原生推理等级**
   插件根据 CLI 返回的模型能力更新 dsh 的 `reasoningEfforts`。dsh 原生“推理等级”菜单随后显示模型实际支持的档位。

8. **发送模型请求**
   dsh 继续使用 `wbrelay` 提供方。用户选择的模型和推理等级通过本地桥接传递到上游，流式思考内容与正文保持独立的响应结构。

看板状态优先读取桥接服务，桥接服务不可达时回退到插件状态接口。状态暂不可确认时，界面保留上次模型列表并标记当前状态。

## 斜杠命令

插件在 dsh 的 `commands` 服务上注册了 `/wbrelay`，可直接在聊天输入框使用（子命令写在命令名之后）：

```text
/wbrelay start | status | hosts | delete | help
```

| 命令 | 作用 |
| --- | --- |
| `/wbrelay start` | 一键启动本地通道：先确保证书可用，再拉起 CLI 服务、443 捕获代理和 8790 桥接，并复查结果 |
| `/wbrelay status` | 汇报设备证书、桥接、CLI、捕获、hosts、token 与引导进度；别名 `st` |
| `/wbrelay hosts` | 启用 hosts 捕获（弹出 UAC 确认） |
| `/wbrelay delete` | 卸载插件：停服务、恢复 hosts、从 profile 注销、清理运行数据；别名 `uninstall` / `remove` |
| `/wbrelay help` | 显示用法；直接发 `/wbrelay` 等同 |

`/wbrelay delete` 的参数：

| 参数 | 作用 |
| --- | --- |
| `--dry-run` | 只列出将要执行的动作，不做任何修改 |
| `--purge` | 连插件源码目录一起删除（先备份到同级目录） |
| `--keep-data` | 保留运行数据与证书，只做注销 |
| `--keep-hosts` | 保留 hosts 设置（不弹 UAC） |
| `--no-install` | 跳过 `pnpm install`，直接删除 `node_modules` 链接（排障用） |

卸载会把 profile 的 `package.json` 备份为 `package.json.bak-uninstall-<时间戳>`；把它覆盖回去、
再按同一路径重新 link 安装即可回滚。注销后需**重启 dsh** 才彻底生效（运行中的进程仍持有已加载的插件代码）。
停止服务时按 `runtimes.json` 记录的 PID 结束**整个进程树**，避免 `cmd.exe` 包装拉起的 CLI 变成孤儿继续占用 60622。
清理的运行数据为 `channel\mitm\captured-token.json` 与 `channel\` 下的 `runtimes.json`、`reasoning-settings.json`、`channel-run.log`；
证书（`ca.*` / `srv.*`）默认保留，只有 `--purge` 才随源码目录一起删除。

## Token 自动捕获

`/wbrelay start` 与看板的「启动通道」都按 **hosts → 443 捕获代理 → CLI → 桥** 的顺序拉起服务，这个顺序是硬约束：

1. hosts 必须把 `copilot.tencent.com` 指向本机，否则上游请求根本不经过代理；
2. 443 捕获代理先就绪；
3. 之后启动的 CLI 会在启动时请求一次 `/v3/config`，这次请求经过代理 → token 被自动捕获；
4. 若 60622 上已有**更早启动**的 CLI 实例（例如桌面版自己拉起的），它不会重新解析上游；插件会自动起一个
   **临时 CLI 实例**补一次上游请求，取到 token 后立刻结束它。

因此正常情况下**不需要**手动打开 CLI 发消息。面板与看板上的「捕获 token」按钮是同一流程
（等价于 `node channel\orchestrator.cjs --token-only`），只在 hosts 未启用或 443 代理不可用时会抓不到 token。

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
| `GET` | `/dsh-plugin-wbrelay/status` | 查询桥接、CLI、hosts、捕获代理、设备证书和 Token 时间戳 |
| `GET` | `/dsh-plugin-wbrelay/models` | 返回模型清单和原生推理同步状态 |
| `POST` | `/dsh-plugin-wbrelay/models/refresh` | 强制刷新模型清单与能力 |
| `POST` | `/dsh-plugin-wbrelay/start` | 启动本地服务 |
| `POST` | `/dsh-plugin-wbrelay/restart` | 重启本地服务 |
| `POST` | `/dsh-plugin-wbrelay/fix-hosts` | 通过管理员授权启用 hosts 捕获 |
| `POST` | `/dsh-plugin-wbrelay/open-cli` | 打开 CodeBuddy CLI 登录窗口（会先确保证书就绪） |
| `GET` | `/dsh-plugin-wbrelay/certs` | 查询设备证书状态：SAN、到期时间、剩余天数、指纹、待处理问题 |
| `POST` | `/dsh-plugin-wbrelay/certs/generate` | 生成或重新生成设备证书，正文 `{"force":true}` 表示强制重签 |
| `GET` | `/dsh-plugin-wbrelay/dashboard` | 打开独立诊断页面 |

## 故障处理

| 现象 | 处理 |
| --- | --- |
| 证书显示「未生成」 | 首次部署的正常状态：启动一次通道，或点看板「生成证书」 |
| `self-signed certificate` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 关闭旧 CLI 窗口，用看板重新打开登录窗口（新进程才会加载新的 `ca.pem`） |
| 证书临近过期 | 自检会自动重签；也可点「重新生成证书」立即处理 |
| 443 代理起不来 | 检查 443 占用；捕获代理与 `certgen.cjs` 都支持换端口，但 hosts 与看板需同步 |
| hosts 未启用 | 点看板「以管理员修复（UAC 确认）」或运行 `channel\mitm\mitm-on.cmd` |
| 桥接服务离线 | 点看板「启动通道」，检查 `8790` 监听状态 |
| 尚未捕获授权 | 点「启动通道」或「捕获 token」：插件会自动起临时 CLI 实例补一次上游请求 |
| 授权已过期 | 点「捕获 token」重新捕获；CLI 登录态失效时先重新 `/login` |
| 从 GitHub 地址安装失败 | 管理器的连接检查（`git ls-remote`）失败：改用归档 URL 或本地目录路径安装 |
| 安装后 `/wbrelay` 与面板按钮都不出现 | 首次安装必须重启 dsh（新模块根不参与热重载）；重启后仍未出现就刷新页面 |
| `/wbrelay start` 之后仍无 token | 顺序是 hosts → 443 代理 → CLI；确认 hosts 已启用后点「捕获 token」 |
| 推理等级缺少档位 | 刷新路由模型并确认 CLI 在线 |

诊断信息以脱敏状态摘要为限。授权头、Token、证书私钥、捕获文件和包含用户内容的日志不属于诊断材料。

## 项目结构

| 文件 | 用途 |
| --- | --- |
| `client.js` | dsh 悬浮按钮、拖动逻辑和内嵌看板 |
| `lib/index.js` | 插件路由、状态查询、服务启动、登录唤醒、`/wbrelay` 斜杠命令与卸载逻辑 |
| `lib/native-reasoning.js` | 模型能力查询与 dsh 原生推理同步 |
| `cordis.patch.yml` | dsh provider、模型和 bundle 配置 |
| `channel/orchestrator.cjs` | 本地服务编排器 |
| `channel/dsh-wb-bridge.cjs` | 模型桥接、请求转换和状态统计 |
| `channel/mitm/tls-capture-443.cjs` | TLS 捕获代理和授权元数据更新（启动时自动确保证书） |
| `channel/mitm/certgen.cjs` | 设备证书生成器：自检、续期、内置引擎与 openssl 引擎 |
| `channel/mitm/gen-certs.cmd` | 证书命令行入口（确保 / `--force` / `--status`） |
| `channel/mitm/CERT.md` | 设备证书说明：参数、手工 openssl 流程、重新生成时机与排错 |
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

停止使用时，在 dsh 输入框执行 `/wbrelay delete` 即可完成卸载（停服务、恢复 hosts、从 profile 注销、清理运行数据）；也可以按下面步骤手工处理：关闭捕获通道并恢复 hosts 设置，再从 dsh profile 的依赖和 bundle 列表移除 `dsh-plugin-wbrelay`。卸载插件不会删除 CodeBuddy 账号或其他 dsh 配置。本机证书、授权文件和运行日志按设备策略单独清理：删除 `channel/mitm` 下的 `*.key`、`*.pem` 与 `captured-token.json`；若曾把 CA 装进系统信任根，再执行 `node channel\mitm\certgen.cjs --remove-trust`。证书相关细节见 [channel/mitm/CERT.md](channel/mitm/CERT.md)。

## 许可证

本项目采用 MIT License。
