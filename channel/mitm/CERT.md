# 捕获证书（设备专用）

捕获代理要在本机终结 `copilot.tencent.com` 的 TLS，才能读到 CLI 请求里的授权头。这需要两张
本机证书：一张自签 CA，一张由该 CA 签发、带 SAN 的目标域名证书。

**证书是设备专用材料，不进 Git，也不随插件分发。** 每台设备、每个安装目录都应当有自己的证书；
插件保证了「谁拿到插件都能在本机一键生成」，不需要向作者索要私钥。

- 生成目录：`channel/mitm/`
- 生成文件：`ca.key`、`ca.pem`、`srv.key`、`srv.pem`
- SAN 来源：`channel/mitm/san.cnf`（默认 `copilot.tencent.com`、`tencent.sso.codebuddy.cn`、`codebuddy.cn`）

---

## 一、默认路径：插件自动生成（推荐）

以下四个入口都会先确保证书可用，缺失 / 过期 / 主机名不覆盖 / 公私钥不配对都会自动重签：

| 入口 | 说明 |
| --- | --- |
| 启动通道 | `channel/dsh-channel.cmd` 或看板「启动通道」时，编排器先生成/自检证书，再拉起 443 代理 |
| 捕获代理自启 | `channel/mitm/tls-capture-443.cjs` 启动时自带证书自检，缺证书也能自己补上 |
| 看板「生成证书」 | 看板「捕获证书」区显示到期时间、剩余天数、指纹；已可用时按钮变为「重新生成证书」 |
| CLI 登录窗口 | 看板「CLI 登录」会确保证书就绪后再注入 `NODE_EXTRA_CA_CERTS` |

一次性命令行入口（不需要管理员权限）：

```powershell
.\channel\mitm\gen-certs.cmd              # 确保存在且有效
.\channel\mitm\gen-certs.cmd --force      # 强制重新生成
.\channel\mitm\gen-certs.cmd --status     # 只看状态，不写文件
```

或者直接调用生成器：

```powershell
node channel\mitm\certgen.cjs
node channel\mitm\certgen.cjs --json
node channel\mitm\certgen.cjs --force
```

生成器有两个等价引擎，结果都能通过 `openssl verify` 与 Node 的链校验：

| 引擎 | 用法 | 依赖 |
| --- | --- | --- |
| 内置（默认） | `node certgen.cjs` | 只要 Node.js，不需要 openssl |
| openssl | `node certgen.cjs --engine openssl` | 需要 `openssl`（装 Git for Windows 即自带） |

## 二、手工路径：等同于文档里的 openssl 流程

如果更希望用命令行手工签发，在 `channel/mitm` 目录执行（PowerShell，OpenSSL 3.x）：

```powershell
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 `
  -keyout ca.key -out ca.pem -subj "/CN=dsh-mitm-ca"

openssl req -newkey rsa:2048 -nodes `
  -keyout srv.key -out srv.csr -subj "/CN=copilot.tencent.com"

openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial `
  -out srv.pem -days 3650 -extfile san.cnf
```

`subjectAltName` 与 `extendedKeyUsage` 由同目录的 `san.cnf` 提供；`-subj` 里的 CN 只是本机标记，
真正生效的是 SAN。签发完成后可删除 `srv.csr` 与 `ca.srl`（插件自己的 openssl 引擎会自动清理）。

签发完成后自检（插件与手工签发通用）：

```powershell
node channel\mitm\certgen.cjs --status
openssl verify -CAfile channel\mitm\ca.pem channel\mitm\srv.pem
```

## 三、生成物与参数

| 文件 | 作用 |
| --- | --- |
| `ca.key` | 本机 CA 私钥。被捕获代理与信任注入使用，**不要外传** |
| `ca.pem` | 本机 CA 证书。通过 `NODE_EXTRA_CA_CERTS` 交给 CLI 信任 |
| `srv.key` | 服务证书私钥，供 443 捕获代理终结 TLS |
| `srv.pem` | 服务证书，含 SAN；由 `ca.pem` 签发 |
| `san.cnf` | SAN 与扩展配置（随插件分发，可自行增删域名） |

生成参数（内置引擎与 openssl 引擎一致）：

| 项 | 取值 |
| --- | --- |
| 签名算法 | `sha256WithRSAEncryption` |
| 密钥 | RSA 2048，PKCS#8 / PEM |
| CA | 自签，`basicConstraints=critical,CA:TRUE`，`keyUsage=critical,keyCertSign,cRLSign`，有效期 3650 天 |
| 服务证书 | `basicConstraints=critical,CA:FALSE`，`keyUsage=critical,digitalSignature,keyEncipherment`，`EKU=serverAuth`，有效期 3650 天 |
| 主机名 | `subjectAltName` 取 `san.cnf`（缺失时用内置默认三个域名） |
| 时间误差 | 生效时间回拨 1 天，避免客户端时钟偏差导致 `not yet valid` |
| 自动续期 | 服务证书剩余不足 30 天 → 只重签服务证书（沿用现有 CA）；CA 剩余不足 1 年或显式 `--force` → 整链重签 |

只重签服务证书时会沿用现有 CA：运行中的 CLI 是在启动时读取 `NODE_EXTRA_CA_CERTS` 的，
CA 不变就不需要重开登录窗口；一旦 CA 也换了（CA 临期或 `--force`），必须用看板重开一次 CLI 登录窗口。

## 四、证书在链路里怎么生效

```text
CLI（登录窗口）          环境变量 NODE_EXTRA_CA_CERTS = channel\mitm\ca.pem
   │                    —— Node 只在启动时读取，所以登录窗口必须由看板/启动器拉起
   ▼
copilot.tencent.com  →  hosts →  127.0.0.1:443  捕获代理用 srv.pem 终结 TLS
   │
   ▼
捕获代理转发上游（真实 IP，SNI 保持 copilot.tencent.com）→ 写入 captured-token.json
   │
   ▼
wbrelay 桥接（8790）读 captured-token.json，直连上游
```

TLS 校验全程保持开启：证书链、主机名、有效期都会校验；插件不会用 `NODE_TLS_REJECT_UNAUTHORIZED`
之类的开关绕过校验。

## 五、什么时候要重新生成

| 情形 | 做法 |
| --- | --- |
| 换设备、换安装目录、复制插件目录 | `gen-certs.cmd --force`（整链重签，之后用看板重开 CLI 登录窗口） |
| 证书临近过期 / 已过期 | 无需手工操作：自检会自动重签，收尾同上；也可点看板「重新生成证书」 |
| 改动 `san.cnf` 增删域名 | `gen-certs.cmd --force`（旧证书的 SAN 不会自动扩展） |
| 怀疑私钥外泄 | `gen-certs.cmd --force`（换 CA），并在 CLI/看板重新打开登录窗口 |
| 从 openssl 手工流程切到内置引擎 | 直接 `gen-certs.cmd`（证书有效则不重签）即可，两种引擎互不冲突 |

> `ca.key` / `srv.key` / `srv.pem` 一旦重签，旧 CA 不再被信任；请通过看板重新打开 CLI 登录窗口，
> 让新进程加载新的 `ca.pem`。

## 六、可选：把 CA 装进系统信任根

只有「不走 `NODE_EXTRA_CA_CERTS` 的客户端」（例如非 Node 的抓包/调试工具）才需要这一步。
默认不做，避免无谓改动系统信任库：

```powershell
node channel\mitm\certgen.cjs --install-trust    # 装进当前用户「受信任的根证书颁发机构」
node channel\mitm\certgen.cjs --remove-trust     # 卸载清理
```

## 七、排错

| 现象 | 处理 |
| --- | --- |
| `self-signed certificate` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 关闭旧 CLI 窗口，用看板重新打开登录窗口；确认 `ca.pem` 与 443 代理正在用的 `srv.pem` 是同一对（`certgen.cjs --status` 显示「有效」） |
| 443 端口起不来 | 看 443 是否被别的程序占用；`certgen.cjs` 与本代理都支持 `--port` 换端口，但 hosts 与看板需要同步 |
| 代理启动即退出 | 运行 `gen-certs.cmd`，查看它打印的失败原因（磁盘权限、路径含特殊字符等） |
| 证书显示「未生成」 | 首次部署的正常状态：启动一次通道，或点看板「生成证书」 |
| 捕获有 token，但模型请求仍报证书错 | 说明是桥接直连上游那一跳：确认 443 代理未被杀掉、hosts 未指向别处 |
| 想彻底清掉证书 | 关闭通道与 hosts 捕获后删除 `channel/mitm/*.key`、`*.pem`；如装过系统信任根，再执行 `--remove-trust` |

证书、私钥、`captured-token.json` 与运行日志都属于本机数据，不要提交到仓库、不要贴进 issue。
