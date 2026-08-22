# EasyTier-Edge

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/fordes123/easytier-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/fordes123/easytier-edge/actions/workflows/ci.yml)

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

- Multiple isolated EasyTier networks behind one `wss://` endpoint
- Noise XX authentication with network-secret proof
- AES-GCM and ChaCha20-Poly1305 authenticated encryption
- OSPF route synchronization and PeerCenter discovery
- Client-to-client UDP/TCP hole-punch coordination through forwarded EasyTier RPC
- Peer-level `Create` / `Sync` / `Join` sessions shared across reconnecting WebSockets
- Periodic OSPF session maintenance and route-version refresh
- Bounded RPC fragmentation, transaction tracking, and anti-replay state
- Frame, hop, and outbound-capacity limits on the relay path
- Opt-in legacy admission for plain EasyTier clients and dynamic public rooms
- No cross-network state

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fordes123/easytier-edge)

The deployment requires three secrets:

- `EASYTIER_NETWORKS`
- `LOCAL_PRIVATE_KEY`
- `LOCAL_PUBLIC_KEY`

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

## Configuration

| Variable | Required | Contract |
| --- | --- | --- |
| `EASYTIER_NETWORKS` | Yes | Non-empty JSON array containing unique `network_name` and non-empty `network_secret` values. |
| `LOCAL_PRIVATE_KEY` | Yes | Base64-encoded 32-byte X25519 private key. |
| `LOCAL_PUBLIC_KEY` | Yes | Matching Base64-encoded 32-byte X25519 public key. |
| `EASYTIER_HOSTNAME` | No | Advertised hostname; defaults to `edge`, maximum 255 UTF-8 bytes. |
| `MAX_FRAME_BYTES` | No | Frame limit; defaults to 1 MiB, allowed range 1 KiB–16 MiB. |
| `EASYTIER_ENABLE_LEGACY` | No | Set to `true` to admit plain (non-secure-mode) EasyTier clients into dynamic rooms. When enabled, `EASYTIER_NETWORKS` may be empty. |

Set production credentials through Wrangler:

```bash
pnpm exec wrangler secret put EASYTIER_NETWORKS
pnpm exec wrangler secret put LOCAL_PRIVATE_KEY
pnpm exec wrangler secret put LOCAL_PUBLIC_KEY
```

## Connect a peer

```bash
easytier-core \
  --network-name office \
  --network-secret 'replace-with-a-random-secret' \
  --secure-mode \
  --local-private-key '<client-private-key>' \
  --local-public-key '<client-public-key>' \
  -p 'wss://<worker-domain>/'
```

Peers sharing a network must use the same network credentials. Networks configured on the same Worker do not share routing, discovery, RPC, or forwarding state.

Only peers that complete `NetworkSecretConfirmed` authentication are admitted. Legacy plaintext and credential-only admission are intentionally rejected by this deployment model unless legacy mode is enabled.

## Legacy mode

Set `EASYTIER_ENABLE_LEGACY=true` to also admit plain EasyTier clients that connect without `--secure-mode`. Rooms are created on demand from the client's `network_name`, so no per-network configuration is required — one relay can serve any number of dynamic rooms (for example [Scaffolding-MC](https://github.com/Scaffolding-MC/Scaffolding-MC) room networks).

```bash
easytier-core \
  --network-name 'any-room-name' \
  --network-secret 'any-room-secret' \
  -p 'wss://<worker-domain>/'
```

How it stays secure without a server-held secret:

- The relay answers the legacy handshake with a zero digest; clients only validate its length.
- The relay advertises `is_public_server` in OSPF route info, so clients send plaintext control RPC to the relay while peer-to-peer traffic stays encrypted with keys derived from the network secret.
- Peers with mismatched secrets never merge routes, so rooms remain isolated at the routing layer.

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
- Protobuf schemas are copied verbatim from EasyTier 2.6.4 under `easytier/src/proto`.

## License

LGPL-3.0. See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md) for upstream attribution.
