# EasyTier-Core（Fork 自 [EasyTier-Edge](https://github.com/fordes123/easytier-edge)）

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/fordes123/easytier-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/fordes123/easytier-edge/actions/workflows/ci.yml)

此项目由[EasyTier-Edge](https://github.com/fordes123/easytier-edge) 修改而来，主要为了适配`Scaffolding-MC`房间网络协议 并且进行了`中继延迟优化`皆在为低成本的为 `MC 公益联机服务`提供支持

已用于[Qomicex Launcher](https://github.com/Qomicex-Public/Qomicex.Tauri)

> **新增：** 公开房间支持与 Scaffolding-MC 房间网络协议兼容。  
> 启用 `EASYTIER_ENABLE_LEGACY=true` 后，可通过单个 `wss://` 端点提供动态、相互隔离的房间，无需按房间单独配置。

**运行在 Cloudflare 边缘的安全 EasyTier WebSocket 中继。**

Rust/WASM 负责 EasyTier 协议。TypeScript 仅负责 Cloudflare 运行时适配器。非休眠 Durable Object 提供连接与房间状态边界。

## 架构

```text
EasyTier peers
      │
      │  Noise XX over WSS
      ▼
Cloudflare Worker
      │  upgrade + health check
      ▼
Durable Object
      ├── TypeScript  · WebSocket lifecycle, room registry, admission, backpressure
      └── Rust/WASM   · framing, forwarding rules, Noise, AEAD, RPC, OSPF, PeerCenter
```

寻址到中继的数据包会被 WASM 核心认证、解密并处理。对等节点之间的数据包保持不透明，仅在其已认证网络内部转发。

## 特性

- **公开房间（新增）：** 启用 legacy 模式后，会根据客户端的 `network_name` 按需创建动态公开房间。一个中继即可服务任意数量的隔离房间。
- **Scaffolding-MC 房间网络协议兼容（新增）：** Scaffolding-MC 房间网络可通过同一公开房间路径连接，无需 `--secure-mode`；房间访问由 `network_name` + `network_secret` 控制。
- 在单个 `wss://` 端点后支持多个隔离的 EasyTier 网络
- 使用网络密钥证明的 Noise XX 认证
- AES-GCM 与 ChaCha20-Poly1305 认证加密
- OSPF 路由同步与 PeerCenter 发现
- 通过转发的 EasyTier RPC 协调客户端到客户端的 UDP/TCP 打洞
- Peer 级 `Create` / `Sync` / `Join` 会话，可在 WebSocket 重连间共享
- 周期性 OSPF 会话维护与路由版本刷新
- 有界 RPC 分片、事务跟踪与防重放状态
- 中继路径上的帧、跳数与出站容量限制
- 可选启用 legacy 准入，支持普通 EasyTier 客户端、公开房间与 Scaffolding-MC 房间网络
- 无跨网络状态

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fordes123/easytier-edge)

部署通常需要三个 secret：

- `EASYTIER_NETWORKS`
- `LOCAL_PRIVATE_KEY`
- `LOCAL_PUBLIC_KEY`

如需部署公开房间或 Scaffolding-MC 房间网络，还需设置 `EASYTIER_ENABLE_LEGACY=true`。在该模式下，`EASYTIER_NETWORKS` 可以为空数组，例如 `[]`。

部署前生成 X25519 服务端身份：

```bash
pnpm run keys
```

## 本地开发

要求：

- Node.js 20+
- pnpm 11+
- Rust 1.95.0，带 `wasm32-unknown-unknown`

```bash
rustup target add wasm32-unknown-unknown
pnpm install
cp .dev.vars.example .dev.vars
pnpm run dev
```

配置 `.dev.vars`：

```dotenv
EASYTIER_NETWORKS=[{"network_name":"office","network_secret":"replace-with-a-random-secret"}]
LOCAL_PRIVATE_KEY=<base64-encoded-32-byte-private-key>
LOCAL_PUBLIC_KEY=<base64-encoded-32-byte-public-key>
EASYTIER_HOSTNAME=edge
```

本地启用公开房间与 Scaffolding-MC 房间网络：

```dotenv
EASYTIER_NETWORKS=[]
EASYTIER_ENABLE_LEGACY=true
LOCAL_PRIVATE_KEY=<base64-encoded-32-byte-private-key>
LOCAL_PUBLIC_KEY=<base64-encoded-32-byte-public-key>
EASYTIER_HOSTNAME=edge
```

## 配置

| 变量 | 必需 | 约定 |
| --- | --- | --- |
| `EASYTIER_NETWORKS` | 条件必需 | 包含唯一 `network_name` 和非空 `network_secret` 值的 JSON 数组。仅安全模式必需。启用 legacy/公开房间模式时，可以为空数组。 |
| `LOCAL_PRIVATE_KEY` | 是 | Base64 编码的 32 字节 X25519 私钥。 |
| `LOCAL_PUBLIC_KEY` | 是 | 匹配的 Base64 编码的 32 字节 X25519 公钥。 |
| `EASYTIER_HOSTNAME` | 否 | 对外通告的主机名；默认 `edge`，最大 255 个 UTF-8 字节。 |
| `MAX_FRAME_BYTES` | 否 | 帧大小限制；默认 1 MiB，允许范围 1 KiB–16 MiB。 |
| `EASYTIER_ENABLE_LEGACY` | 否 | 设为 `true` 以启用 **公开房间** 与 **Scaffolding-MC 房间网络兼容**。普通（非 secure-mode）EasyTier 客户端会根据其 `network_name` 按需加入房间。启用后，`EASYTIER_NETWORKS` 可以为空。 |

通过 Wrangler 设置生产凭据：

```bash
pnpm exec wrangler secret put EASYTIER_NETWORKS
pnpm exec wrangler secret put LOCAL_PRIVATE_KEY
pnpm exec wrangler secret put LOCAL_PUBLIC_KEY
```

公开房间或 Scaffolding-MC 部署：

```bash
pnpm exec wrangler secret put EASYTIER_ENABLE_LEGACY
# 值：true
```

## 连接节点

推荐默认使用安全模式：

```bash
easytier-core \
  --network-name office \
  --network-secret 'replace-with-a-random-secret' \
  --secure-mode \
  --local-private-key '<client-private-key>' \
  --local-public-key '<client-public-key>' \
  -p 'wss://<worker-domain>/'
```

共享同一网络的节点必须使用相同的网络凭据。同一 Worker 上配置的网络之间不共享路由、发现、RPC 或转发状态。

只有完成 `NetworkSecretConfirmed` 认证的节点才会被准入。除非启用 legacy 模式，否则该部署模型会明确拒绝 legacy 明文与仅凭据准入。

公开房间或 Scaffolding-MC 房间网络见下文。

## 公开房间、legacy 模式与 Scaffolding-MC 支持

设置 `EASYTIER_ENABLE_LEGACY=true` 后，也会准入未使用 `--secure-mode` 的普通 EasyTier 客户端。

**本 fork 新增：**

- **公开房间** 会根据客户端的 `network_name` 按需创建。
- 一个中继可服务任意数量的动态房间。
- 无需按房间进行 Worker 配置。
- **Scaffolding-MC 房间网络** 通过同一公开房间路径获得支持，例如 [Scaffolding-MC](https://github.com/Scaffolding-MC/Scaffolding-MC) 房间网络。

### 连接公开房间

```bash
easytier-core \
  --network-name 'any-room-name' \
  --network-secret 'any-room-secret' \
  -p 'wss://<worker-domain>/'
```

无需 `--secure-mode`，也无需按房间进行 Worker 配置。

### 连接 Scaffolding-MC 房间网络

将 Scaffolding-MC 房间名用作 `--network-name`，房间密钥用作 `--network-secret`：

```bash
easytier-core \
  --network-name '<scaffolding-mc-room-name>' \
  --network-secret '<scaffolding-mc-room-secret>' \
  -p 'wss://<worker-domain>/'
```

中继会按需创建房间，并使其与其他房间保持隔离。

### 没有服务端持有密钥时如何保持安全

- 中继对 legacy 握手返回零摘要；客户端仅校验其长度。
- 中继在 OSPF 路由信息中通告 `is_public_server`，因此客户端会向中继发送明文控制 RPC，而对等流量仍使用由网络密钥派生的密钥加密。
- 密钥不匹配的节点永远不会合并路由，因此房间在路由层保持隔离。
- 公开房间与 Scaffolding-MC 房间网络不会与其他房间共享路由、发现、RPC 或转发状态。

## 工具链

| 命令 | 操作 |
| --- | --- |
| `pnpm run build:wasm` | 构建 `easytier-edge-wasm`。 |
| `pnpm run typecheck` | 检查 TypeScript。 |
| `pnpm run test` | 运行 Vitest。 |
| `pnpm run build` | 构建 WASM 并运行 Wrangler dry build。 |
| `pnpm run deploy` | 构建并部署 Worker。 |

## 运行时契约

- WebSocket 端点：`GET /`
- 配置探测：`GET /healthz`
- 中继 peer ID：`10000001`
- 每个 Durable Object 的最大同时 WebSocket 连接数：2048
- Worker 没有本地 TUN 接口，也不打开 UDP 打洞套接字；它转发控制 RPC，使客户端之间可以直接打洞。
- 会话与防重放状态位于非休眠 Durable Object 中。
- 当 `EASYTIER_ENABLE_LEGACY=true` 时，公开房间会根据 `network_name` 动态创建。
- Scaffolding-MC 房间网络通过公开房间路径获得支持。
- Protobuf schema 逐字复制自 EasyTier 2.6.4，位于 `easytier/src/proto`。

## 许可证

LGPL-3.0。上游署名见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
