# EasyTier-Core (Fork from [EasyTier-Edge](https://github.com/fordes123/easytier-edge))

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/fordes123/easytier-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/fordes123/easytier-edge/actions/workflows/ci.yml)

This project is forked from [EasyTier-Edge](https://github.com/fordes123/easytier-edge), mainly to adapt the `Scaffolding-MC` room-network protocol, and includes `relay latency optimizations`, aiming to provide low-cost support for `MC public multiplayer services`.

Already used in [Qomicex Launcher](https://github.com/Qomicex-Public/Qomicex.Tauri)

> **New:** Public room support and Scaffolding-MC room-network protocol compatibility.  
> Enable `EASYTIER_ENABLE_LEGACY=true` to serve dynamic, isolated rooms from one `wss://` endpoint — no per-room configuration required.

**A secure EasyTier WebSocket relay running at the Cloudflare edge.**

Rust/WASM owns the EasyTier protocol. TypeScript owns only the Cloudflare runtime adapter. A non-hibernating Durable Object provides the connection and room state boundary.

## Architecture

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

Packets addressed to the relay are authenticated, decrypted, and processed by the WASM core. Peer-to-peer packets stay opaque and are forwarded only inside their authenticated network.

## Properties

- **Public rooms (new):** When legacy mode is enabled, dynamic public rooms are created on demand from the client's `network_name`. One relay can serve any number of isolated rooms.
- **Scaffolding-MC room-network protocol compatibility (new):** Scaffolding-MC room networks can connect through the same public-room path without `--secure-mode`; room access is controlled by `network_name` + `network_secret`.
- Multiple isolated EasyTier networks behind one `wss://` endpoint
- Noise XX authentication with network-secret proof
- AES-GCM and ChaCha20-Poly1305 authenticated encryption
- OSPF route synchronization and PeerCenter discovery
- Client-to-client UDP/TCP hole-punch coordination through forwarded EasyTier RPC
- Peer-level `Create` / `Sync` / `Join` sessions shared across reconnecting WebSockets
- Periodic OSPF session maintenance and route-version refresh
- Bounded RPC fragmentation, transaction tracking, and anti-replay state
- Frame, hop, and outbound-capacity limits on the relay path
- Opt-in legacy admission for plain EasyTier clients, public rooms, and Scaffolding-MC room networks
- No cross-network state

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fordes123/easytier-edge)

Deployment usually requires three secrets:

- `EASYTIER_NETWORKS`
- `LOCAL_PRIVATE_KEY`
- `LOCAL_PUBLIC_KEY`

To deploy public rooms or Scaffolding-MC room networks, also set `EASYTIER_ENABLE_LEGACY=true`. In this mode, `EASYTIER_NETWORKS` may be an empty array, for example `[]`.

Generate the X25519 server identity before deployment:

```bash
pnpm run keys
```

## Local development

Requirements:

- Node.js 20+
- pnpm 11+
- Rust 1.95.0 with `wasm32-unknown-unknown`

```bash
rustup target add wasm32-unknown-unknown
pnpm install
cp .dev.vars.example .dev.vars
pnpm run dev
```

Configure `.dev.vars`:

```dotenv
EASYTIER_NETWORKS=[{"network_name":"office","network_secret":"replace-with-a-random-secret"}]
LOCAL_PRIVATE_KEY=<base64-encoded-32-byte-private-key>
LOCAL_PUBLIC_KEY=<base64-encoded-32-byte-public-key>
EASYTIER_HOSTNAME=edge
```

To enable public rooms and Scaffolding-MC room networks locally:

```dotenv
EASYTIER_NETWORKS=[]
EASYTIER_ENABLE_LEGACY=true
LOCAL_PRIVATE_KEY=<base64-encoded-32-byte-private-key>
LOCAL_PUBLIC_KEY=<base64-encoded-32-byte-public-key>
EASYTIER_HOSTNAME=edge
```

## Configuration

| Variable | Required | Contract |
| --- | --- | --- |
| `EASYTIER_NETWORKS` | Conditionally required | JSON array containing unique `network_name` and non-empty `network_secret` values. Required only in secure mode. When legacy/public-room mode is enabled, it may be an empty array. |
| `LOCAL_PRIVATE_KEY` | Yes | Base64-encoded 32-byte X25519 private key. |
| `LOCAL_PUBLIC_KEY` | Yes | Matching Base64-encoded 32-byte X25519 public key. |
| `EASYTIER_HOSTNAME` | No | Advertised hostname; defaults to `edge`, maximum 255 UTF-8 bytes. |
| `MAX_FRAME_BYTES` | No | Frame limit; defaults to 1 MiB, allowed range 1 KiB–16 MiB. |
| `EASYTIER_ENABLE_LEGACY` | No | Set to `true` to enable **public rooms** and **Scaffolding-MC room-network compatibility**. Plain (non-secure-mode) EasyTier clients join rooms on demand based on their `network_name`. When enabled, `EASYTIER_NETWORKS` may be empty. |

Set production credentials through Wrangler:

```bash
pnpm exec wrangler secret put EASYTIER_NETWORKS
pnpm exec wrangler secret put LOCAL_PRIVATE_KEY
pnpm exec wrangler secret put LOCAL_PUBLIC_KEY
```

For public-room or Scaffolding-MC deployment:

```bash
pnpm exec wrangler secret put EASYTIER_ENABLE_LEGACY
# value: true
```

## Connect a peer

Secure mode is recommended by default:

```bash
easytier-core \
  --network-name office \
  --network-secret 'replace-with-a-random-secret' \
  --secure-mode \
  --local-private-key '<client-private-key>' \
  --local-public-key '<client-public-key>' \
  -p 'wss://<worker-domain>/'
```

Peers sharing the same network must use the same network credentials. Networks configured on the same Worker do not share routing, discovery, RPC, or forwarding state.

Only peers that complete `NetworkSecretConfirmed` authentication are admitted. Unless legacy mode is enabled, this deployment model explicitly rejects legacy plaintext and credential-only admission.

For public rooms or Scaffolding-MC room networks, see below.

## Public rooms, legacy mode, and Scaffolding-MC support

Setting `EASYTIER_ENABLE_LEGACY=true` also admits plain EasyTier clients that do not use `--secure-mode`.

**New in this fork:**

- **Public rooms** are created on demand from the client's `network_name`.
- One relay can serve any number of dynamic rooms.
- No per-room Worker configuration is required.
- **Scaffolding-MC room networks** are supported through the same public-room path, for example [Scaffolding-MC](https://github.com/Scaffolding-MC/Scaffolding-MC) room networks.

### Connect a public room

```bash
easytier-core \
  --network-name 'any-room-name' \
  --network-secret 'any-room-secret' \
  -p 'wss://<worker-domain>/'
```

No `--secure-mode` and no per-room Worker configuration are needed.

### Connect a Scaffolding-MC room network

Use the Scaffolding-MC room name as `--network-name` and the room secret as `--network-secret`:

```bash
easytier-core \
  --network-name '<scaffolding-mc-room-name>' \
  --network-secret '<scaffolding-mc-room-secret>' \
  -p 'wss://<worker-domain>/'
```

The relay creates the room on demand and keeps it isolated from other rooms.

### How it stays secure without a server-held secret

- The relay answers the legacy handshake with a zero digest; clients only validate its length.
- The relay advertises `is_public_server` in OSPF route info, so clients send plaintext control RPC to the relay while peer-to-peer traffic stays encrypted with keys derived from the network secret.
- Peers with mismatched secrets never merge routes, so rooms remain isolated at the routing layer.
- Public rooms and Scaffolding-MC room networks do not share routing, discovery, RPC, or forwarding state with other rooms.

## Toolchain

| Command | Action |
| --- | --- |
| `pnpm run build:wasm` | Build `easytier-edge-wasm`. |
| `pnpm run typecheck` | Check TypeScript. |
| `pnpm run test` | Run Vitest. |
| `pnpm run build` | Build WASM and run a Wrangler dry build. |
| `pnpm run deploy` | Build and deploy the Worker. |

## Runtime contract

- WebSocket endpoint: `GET /`
- Configuration probe: `GET /healthz`
- Relay peer ID: `10000001`
- Maximum simultaneous WebSocket connections per Durable Object: 2048
- The Worker has no local TUN interface and opens no UDP hole-punch sockets; it relays the control RPC that lets clients punch paths directly between themselves.
- Session and anti-replay state live in a non-hibernating Durable Object.
- When `EASYTIER_ENABLE_LEGACY=true`, public rooms are dynamically created from `network_name`.
- Scaffolding-MC room networks are supported through the public-room path.
- Protobuf schemas are copied verbatim from EasyTier 2.6.4 under `easytier/src/proto`.

## License

LGPL-3.0. See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md) for upstream attribution.
