<div align="center">

# dsh-plugin-wbrelay

**面向 dsh 的 CodeBuddy CLI 模型桥接插件**

![Version](https://img.shields.io/badge/version-1.0.0-0f766e?style=flat-square)

![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square)

![License](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)

[快速开始](#快速开始) · [功能概览](#功能概览) · [模型配置](#模型配置) · [安全说明](#安全说明)

</div>

---

`dsh-plugin-wbrelay` 为 dsh 提供基于 CodeBuddy CLI 的本地模型桥接能力。插件包含 dsh bundle 配置、可拖动状态看板、本地桥接服务、Token 捕获支持和原生推理等级同步。

插件通过本机回环地址转发请求，不要求运行桌面端应用。CodeBuddy CLI 负责登录和授权，wbrelay 负责将 dsh 的模型请求转换为兼容接口并转发至上游服务。

> [!NOTE]  
> 本项目是独立的第三方插件，不代表 dsh、CodeBuddy 或其关联服务的官方立场。

## 插件标识

| 用途              | 标识                   |
| --------------- | -------------------- |
| 插件包名与 bundle ID | `dsh-plugin-wbrelay` |
| dsh 模型提供方       | `wbrelay`            |
| 界面按钮            | `wbrelay`            |
| 本地桥接端口          | `8790`               |

## 功能概览

| 功能       | 说明                                    |
| -------- | ------------------------------------- |
| 模型桥接     | 将 dsh 的 OpenAI 兼容请求转发至 CodeBuddy 上游路由 |
| 内嵌看板     | 在 dsh 界面中显示状态，并支持拖动按钮位置               |
| CLI 状态   | 查看服务、运行状态和登录状态，可直接唤醒 CLI 登录窗口         |
| Token 状态 | 展示捕获时间、签发时间、过期时间和剩余有效期                |
| 路由模型     | 拉取模型列表，并显示各模型可用的推理档位                  |
| 原生推理等级   | 将已确认的模型能力同步至 dsh 原生“推理等级”菜单           |
| 捕获管理     | 检查 443 代理与 hosts 状态，并在需要时请求管理员授权      |
| 运行监控     | 展示端口、运行时长、请求统计和最近一次错误                 |
| 版本信息     | 在看板中显示插件版本，并预留更新入口                    |

## 工作方式

```text
dsh
  │
  └─ http://127.0.0.1:8790/v1
       │
       └─ wbrelay 本地桥接服务
            │
            └─ CodeBuddy 上游模型路由

CodeBuddy CLI
  │
  └─ 登录并发起请求
       │
       └─ 本地捕获代理更新授权信息
```

主要本地服务端口：

| 端口      | 用途                |
| ------- | ----------------- |
| `8790`  | wbrelay 模型桥接与状态接口 |
| `443`   | TLS 捕获代理          |
| `60622` | CodeBuddy CLI 服务  |

捕获代理启用后，目标域名会通过 hosts 指向本机代理。停止代理前应恢复 hosts 设置。

## 环境要求

- Windows。
- Git。
- 可加载 bundle 插件的 dsh。
- Node.js `>=18`。
- pnpm。
- CodeBuddy CLI 和可用的登录账号。
- 修改 hosts 所需的管理员权限。
- 用于本机捕获代理的设备专用证书（自行生成，见步骤 3）。

## 快速开始

### 1. 克隆仓库

将 `<OWNER>/<REPOSITORY>` 替换为实际的 GitHub 仓库地址：

```powershell
git clone https://github.com/<OWNER>/<REPOSITORY>.git dsh-plugin-wbrelay
Set-Location dsh-plugin-wbrelay
```

也可以在 GitHub 仓库页面选择 **Code → HTTPS**，复制实际地址后执行 `git clone`。

> [!IMPORTANT]  
> 仓库不含任何证书或私钥，克隆后必须执行步骤 3 在本机生成，否则捕获通道无法启动。

### 2. 安装 CodeBuddy CLI

```powershell
npm install --global @tencent-ai/codebuddy-code
```

### 3. 生成设备证书

仓库**不包含任何证书或私钥**，每台设备必须自行生成一套。在 `channel/mitm` 目录执行：

```powershell
# 1) 生成设备专用 CA（有效期 10 年）
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 `
  -keyout ca.key -out ca.pem -subj "/CN=wbrelay-local-ca"

# 2) 生成服务器私钥与证书签名请求
openssl req -newkey rsa:2048 -nodes -keyout srv.key -out srv.csr -subj "/CN=copilot.tencent.com"

# 3) 用 san.cnf 中的 SAN 列表签发服务器证书
openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial `
  -out srv.pem -days 3650 -extfile san.cnf
```

生成后 `channel/mitm` 下应存在 `ca.key`、`ca.pem`、`srv.key`、`srv.pem`。这四个文件已被 `.gitignore` 排除，**请勿提交、打包或分享给他人** —— 持有它们即可伪造任意 HTTPS 站点的证书。签发完成后可删除中间文件 `srv.csr`、`ca.srl`。

### 4. 注册 dsh 插件

在仓库根目录执行以下命令，生成源码链接值：

```powershell
'link:' + (Get-Location).Path.Replace('\', '/')
```

将生成的值写入 dsh 当前 profile 的 `package.json`，并把 `dsh-plugin-wbrelay` 加入 profile 的 bundle 列表。需要合并的字段如下：

```json
{
  "dependencies": {
    "dsh-plugin-wbrelay": "link:<repository-root>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-plugin-wbrelay"
      ]
    }
  }
}
```

请保留 profile 中已有的依赖、bundle 和用户配置，然后在 profile 目录执行：

```powershell
pnpm install
```

修改插件源码后，重启 dsh 以重新加载 bundle。

### 5. 启动本地通道

可以从 dsh 的 wbrelay 看板点击“启动通道”，也可以在仓库根目录执行：

```powershell
node channel/orchestrator.cjs
```

或运行：

```powershell
.\channel\dsh-channel.cmd
```

启动器会按需检查并启动 CLI 服务、捕获代理和本地桥接服务。

### 6. 启用 hosts 捕获

首次使用时，在看板中点击“启用捕获”，并在管理员授权窗口中确认。也可以在管理员 PowerShell 中执行：

```powershell
.\channel\mitm\mitm-on.cmd
```

启用后，目标域名会被定向到本机捕获代理。停用时执行：

```powershell
.\channel\mitm\mitm-off.cmd
```

### 7. 登录并捕获授权

1. 在看板中点击“CLI 登录”。
2. 在打开的 CodeBuddy CLI 窗口中完成登录。
3. 发送一条正常消息，使 CLI 发起上游请求。
4. 返回 dsh 看板刷新状态，确认 Token 已捕获。

通过看板打开的 CLI 会加载本机捕获 CA，并保持 TLS 校验开启。Token 过期后，需要重新登录或刷新 CLI 状态，并再次产生请求以更新授权信息。

### 8. 选择模型并发送消息

在 dsh 中选择 `wbrelay` 提供方的模型，发送消息即可使用桥接服务。看板中的模型列表和能力信息用于辅助确认配置，最终可用性以实际请求结果为准。

## 看板

点击 `wbrelay` 按钮可展开看板，拖动按钮可以调整位置；位置保存在当前浏览器的本地存储中。

看板包含以下区域：

| 区域            | 内容                         |
| ------------- | -------------------------- |
| CodeBuddy CLI | 服务状态、运行状态、网关认证和登录入口        |
| Token 时间戳     | 签发时间、过期时间、最近捕获时间和剩余有效期     |
| 路由模型          | 模型列表、推理能力和能力同步状态           |
| 桥接状态          | 引擎、端口、捕获代理、hosts、运行时长和请求统计 |
| 版本信息          | 当前插件版本和更新入口                |

状态刷新优先读取桥接服务；桥不可达时会回退到插件状态。状态接口暂时不可用时，看板会保留上一次数据并标记为未确认。

独立诊断页面可通过桥接服务的 dashboard 路由访问。诊断页中的上游连通性探测可能产生真实模型请求，使用前请确认账号和服务策略。

## 模型配置

插件自带的 `cordis.patch.yml` 提供 `wbrelay` 模型提供方和默认模型。默认配置如下：

| 配置项      | 默认值                        |
| -------- | -------------------------- |
| 提供方      | `wbrelay`                  |
| API 类型   | `openai-completions`       |
| Base URL | `http://127.0.0.1:8790/v1` |
| 默认模型     | `glm-5.3-flash`            |
| 请求头      | `x-wb-session: dsh`        |

如需增加或移除模型，请修改实际生效配置中的 `providers.wbrelay.models`，然后重启 dsh。不要覆盖 profile 中其他提供方或用户配置。

## 原生推理等级

选择 `wbrelay` 模型后，dsh 输入框中的原生“推理等级”菜单会显示该模型已确认的能力。

插件会：

1. 从 CodeBuddy CLI 查询模型能力。
2. 将支持的推理档位同步到 dsh 模型配置。
3. 在请求中传递用户选择的推理强度。
4. 保留流式思考内容与正文的分离结构。

支持的档位由上游模型动态决定，通常包括 `minimal`、`low`、`medium`、`high`、`xhigh` 和 `max` 中的一部分。不可关闭思考的模型不会显示“关闭”选项。

同步过程只更新已配置且指向本机 wbrelay 桥的模型能力，不会修改其他提供方、凭据、地址或兼容配置。CLI 暂不可用时，插件保留已有能力并在看板中标记为未确认。

## 更新入口

看板和诊断页已包含“一键获取更新”入口。公开仓库发布后，在 `client.js` 中填写更新地址即可启用跳转；未配置地址时按钮只显示占位提示，不会发起网络请求。

## 故障处理

| 现象         | 建议                                                        |
| ---------- | --------------------------------------------------------- |
| 桥接服务离线     | 从看板启动通道，或执行 `channel/orchestrator.cjs`，确认 `8790` 未被其他程序占用 |
| hosts 未启用  | 使用看板中的“启用捕获”，或在管理员终端运行 `channel/mitm/mitm-on.cmd`         |
| 尚未捕获 Token | 确认 CLI 已登录、捕获代理正在运行，并从新 CLI 窗口发送一条消息                      |
| Token 已过期  | 刷新 CLI 登录状态并再次发起请求，等待看板更新                                 |
| TLS 证书错误   | 确认 `channel/mitm` 下已按「生成设备证书」自行生成 `ca.pem` / `srv.pem`，检查证书链与 CLI 的 CA 配置，不要关闭 TLS 校验 |
| 证书文件缺失     | 仓库不含证书，请按步骤 3 在本机生成；缺少 `ca.pem` 时 CLI 登录窗口无法建立捕获通道            |
| dsh 返回连接错误 | 依次检查桥端口、捕获代理、hosts、Token 有效期和看板中的最近错误                     |
| 推理等级缺少档位   | 刷新路由模型，确认 CLI 在线，并检查当前模型是否支持对应档位                          |
| 某个模型调用失败   | 检查模型 ID、账号权限、上游返回信息和模型能力声明                                |

排障时只分享脱敏后的状态摘要。不要粘贴授权头、Token、证书私钥、捕获文件或包含用户内容的日志。

## 项目结构

| 文件                                 | 用途                         |
| ---------------------------------- | -------------------------- |
| `client.js`                        | dsh 悬浮按钮、拖动逻辑和内嵌看板         |
| `lib/index.js`                     | 插件状态接口、启动、登录和 hosts 管理     |
| `lib/native-reasoning.js`          | CLI 模型能力查询与 dsh 原生能力同步     |
| `cordis.patch.yml`                 | dsh provider、模型和 bundle 配置 |
| `channel/orchestrator.cjs`         | 本地服务编排器                    |
| `channel/dsh-wb-bridge.cjs`        | 模型桥接、请求转发和状态统计             |
| `channel/mitm/tls-capture-443.cjs` | TLS 捕获代理和授权文件更新            |
| `channel/mitm/san.cnf`             | 设备证书的 SAN 配置（供签名时使用）        |
| `channel/mitm/*.key`、`*.pem`       | 本机生成的证书与私钥，**不纳入版本控制**     |

## 安全说明

请勿提交或分发以下内容：

- 捕获到的授权文件和 Token。
- 设备专用 CA 私钥、服务器私钥和证书（`channel/mitm/*.key`、`*.pem`）。
- 运行日志、调试转储和临时凭据。
- 本机推理设置、dsh profile、CodeBuddy profile 和会话数据。
- 未经过脱敏处理的截图、请求正文或响应内容。

以上文件均已写入 `.gitignore`。提交前请用 `git status` 确认它们未被跟踪；若曾误提交，仅从工作区删除并不够，必须重写 Git 历史并**立即吊销重签**相关证书。

捕获代理会在当前设备上解密目标域名的请求，并将授权信息写入本机运行目录。请限制相关文件的访问权限，并在不再使用时清理捕获文件和证书。

桥接服务和 CLI 服务默认只监听本机回环地址。不要将这些端口暴露到公网，也不要通过端口转发或隧道共享。

## 停用与卸载

1. 在管理员终端运行 `channel/mitm/mitm-off.cmd`，恢复 hosts 设置。
2. 确认并停止由本插件启动的 CLI、捕获代理和桥接服务。
3. 从 dsh profile 的依赖和 bundle 列表中移除 `dsh-plugin-wbrelay`。
4. 在 profile 目录执行 `pnpm install`，然后重启 dsh。
5. 根据需要清理本机捕获文件、证书和运行日志。

卸载插件不会自动删除 CodeBuddy 账号或其他 dsh 配置。

## 许可证

本项目采用 MIT License。
