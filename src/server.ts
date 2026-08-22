import { DurableObject } from "cloudflare:workers";
import { SecurePeer } from "./wasm";
import {
	EASYTIER_HEADER_SIZE,
	ENCRYPTED_FLAG,
	PacketType,
	SERVER_PEER_ID,
} from "./core/constants";
import { type EasyTierEnv, type ServerConfig, readServerConfig } from "./core/config";
import {
	bumpForwardCounter,
	createPacket,
	parsePacket,
	readHeader,
	toUint8Array,
} from "./core/packet";
import { buildLegacyHandshakeResponse, parseLegacyHandshake } from "./core/legacy";
import { EasyTierRpc } from "./core/rpc";
import {
	type Connection,
	completeHandshake,
	createConnection,
	disposeConnection,
} from "./runtime/connection";
import { errorMessage } from "./runtime/errors";
import { parseAuthenticationInfo, parseHandshakeInfo } from "./runtime/messages";
import { RoomRegistry } from "./runtime/rooms";

const MAX_CONNECTIONS = 2_048;

export class EasyTierServer extends DurableObject<EasyTierEnv> {
	private readonly config: ServerConfig;
	private readonly rpc: EasyTierRpc;
	private readonly connections = new Map<WebSocket, Connection>();
	private readonly rooms = new RoomRegistry();
	private maintenanceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: DurableObjectState, env: EasyTierEnv) {
		super(ctx, env);
		this.config = readServerConfig(env);
		this.rpc = new EasyTierRpc(
			this.config.localPublicKeyBytes,
			this.config.hostname,
			SERVER_PEER_ID,
		);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/") return new Response("Not found", { status: 404 });
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		if (this.connections.size >= MAX_CONNECTIONS) {
			return new Response("EasyTier connection capacity exceeded", { status: 503 });
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.binaryType = "arraybuffer";
		server.accept();

		const connection = createConnection(server, (expired) => {
			this.close(expired, 4408, "secure handshake timeout");
		});
		this.connections.set(server, connection);
		this.scheduleMaintenance();
		server.addEventListener("message", (event) => {
			try {
				this.handleMessage(connection, event.data);
			} catch (error) {
				this.failConnection(connection, error);
			}
		});
		server.addEventListener("close", () => this.removeConnection(connection));
		server.addEventListener("error", () => this.removeConnection(connection));

		return new Response(null, { status: 101, webSocket: client });
	}

	private handleMessage(connection: Connection, data: string | ArrayBuffer): void {
		const frame = toUint8Array(data);
		if (frame.byteLength > this.config.maxFrameBytes) {
			throw new Error("EasyTier frame exceeds MAX_FRAME_BYTES");
		}
		// ready 阶段是转发热路径，走纯 TS 头解析避免 WASM 边界开销
		if (connection.phase === "ready") {
			this.handleReadyPacket(connection, frame);
			return;
		}
		const packet = parsePacket(frame);
		switch (connection.phase) {
			case "undecided":
				this.handleFirstPacket(connection, frame, packet.header.packetType);
				return;
			case "msg1":
				this.handleHandshakeMessage1(connection, frame, packet.header.packetType);
				return;
			case "msg3":
				this.handleHandshakeMessage3(connection, frame, packet.header.packetType);
				return;
			case "closed":
				return;
		}
	}

	private handleFirstPacket(
		connection: Connection,
		frame: Uint8Array,
		packetType: number,
	): void {
		if (packetType === PacketType.HandShake) {
			if (!this.config.allowLegacy) {
				throw new Error("legacy admission is disabled on this relay");
			}
			this.handleLegacyHandshake(connection, frame);
			return;
		}
		if (packetType === PacketType.NoiseHandshakeMsg1) {
			connection.secure = new SecurePeer(
				this.config.localPrivateKey,
				this.config.localPublicKey,
				SERVER_PEER_ID,
			);
			connection.mode = "secure";
			connection.phase = "msg1";
			this.handleHandshakeMessage1(connection, frame, packetType);
			return;
		}
		throw new Error("secure_mode rejects legacy or out-of-order handshakes");
	}

	private handleLegacyHandshake(connection: Connection, frame: Uint8Array): void {
		const info = parseLegacyHandshake(frame.subarray(EASYTIER_HEADER_SIZE));
		if (info.peerId === SERVER_PEER_ID) {
			throw new Error("legacy peer id conflicts with the relay peer id");
		}
		connection.mode = "legacy";
		connection.peerId = info.peerId;
		connection.networkName = info.networkName;
		const response = buildLegacyHandshakeResponse(SERVER_PEER_ID, info.networkName);
		connection.send(
			createPacket(SERVER_PEER_ID, info.peerId, PacketType.HandShake, response),
		);
		this.registerConnection(connection);
		completeHandshake(connection);
		this.broadcastRouteUpdate(connection.networkName);
	}

	private requireSecure(connection: Connection): SecurePeer {
		if (connection.secure === null) {
			throw new Error("secure handshake started without a secure peer context");
		}
		return connection.secure;
	}

	private handleHandshakeMessage1(
		connection: Connection,
		frame: Uint8Array,
		packetType: number,
	): void {
		if (packetType !== PacketType.NoiseHandshakeMsg1) {
			throw new Error("secure_mode rejects legacy or out-of-order handshakes");
		}
		const secure = this.requireSecure(connection);
		const info = parseHandshakeInfo(secure.read_msg1(frame));
		const room = this.config.rooms.get(info.networkName);
		if (room === undefined) {
			this.close(connection, 4403, "network is not configured");
			return;
		}
		connection.peerId = info.peerId;
		connection.networkName = info.networkName;
		connection.send(secure.build_msg2(room.network_secret));
		connection.phase = "msg3";
	}

	private handleHandshakeMessage3(
		connection: Connection,
		frame: Uint8Array,
		packetType: number,
	): void {
		if (packetType !== PacketType.NoiseHandshakeMsg3) {
			throw new Error("expected NoiseHandshakeMsg3");
		}
		const auth = parseAuthenticationInfo(this.requireSecure(connection).finish_msg3(frame));
		if (
			auth.peerId !== connection.peerId ||
			auth.networkName !== connection.networkName
		) {
			throw new Error("secure handshake identity mismatch");
		}
		connection.remotePublicKey = auth.remotePublicKey;
		this.registerConnection(connection);
		completeHandshake(connection);
		this.broadcastRouteUpdate(connection.networkName);
	}

	private handleReadyPacket(connection: Connection, frame: Uint8Array): void {
		const header = readHeader(frame);
		if (header.toPeerId !== SERVER_PEER_ID) {
			const target = this.findPeer(connection.networkName, header.toPeerId);
			if (!target || target.phase !== "ready") return;
			bumpForwardCounter(frame);
			try {
				target.send(frame);
			} catch (error) {
				console.warn("EasyTier forwarding target rejected", {
					networkName: target.networkName,
					peerId: target.peerId,
					error: errorMessage(error),
				});
				this.close(target, 1013, "outbound relay capacity exceeded");
			}
			return;
		}
		if (header.fromPeerId !== connection.peerId) {
			throw new Error("direct control packet source does not match the authenticated peer");
		}

		if (
			(header.packetType === PacketType.Ping || header.packetType === PacketType.Pong) &&
			(header.flags & ENCRYPTED_FLAG) !== 0
		) {
			throw new Error("EasyTier Ping and Pong packets must remain unencrypted");
		}
		if (header.packetType === PacketType.Ping) {
			frame[8] = PacketType.Pong;
			connection.send(frame);
			return;
		}
		if (header.packetType === PacketType.Pong) return;
		if (header.packetType !== PacketType.RpcReq && header.packetType !== PacketType.RpcResp) {
			// 本节点没有本地 TUN；数据包和端到端中继握手只有发往其他节点时才有意义。
			return;
		}

		let clearPayload: Uint8Array;
		if (connection.mode === "secure") {
			if ((header.flags & ENCRYPTED_FLAG) === 0) {
				throw new Error("secure_mode requires encrypted direct RPC packets");
			}
			const clear = this.requireSecure(connection).decrypt_packet(frame);
			if (clear.byteLength === 0) return;
			clearPayload = parsePacket(clear).payload;
		} else {
			// 客户端尚未通过路由信息得知本节点是公共服务器时会发加密包，丢弃等待其重试。
			if ((header.flags & ENCRYPTED_FLAG) !== 0) return;
			clearPayload = frame.subarray(EASYTIER_HEADER_SIZE);
		}

		if (header.packetType === PacketType.RpcReq) {
			const result = this.rpc.handleRequest(connection, clearPayload);
			if (result === "route") this.broadcastRouteUpdate(connection.networkName, connection.peerId);
		} else {
			this.rpc.handleResponse(connection, clearPayload);
		}
	}

	private registerConnection(connection: Connection): void {
		const replaced = this.rooms.set(connection);
		if (replaced && replaced !== connection) {
			this.close(replaced, 4000, "replaced by an authenticated reconnect");
		}
		if (connection.mode === "legacy") {
			this.rpc.addLegacyPeer(connection);
		} else {
			this.rpc.addPeer(connection);
		}
	}

	private removeConnection(connection: Connection): void {
		if (connection.phase === "closed") return;
		const wasReady = connection.phase === "ready";
		connection.phase = "closed";
		this.connections.delete(connection.socket);
		if (this.connections.size === 0 && this.maintenanceTimer) {
			clearTimeout(this.maintenanceTimer);
			this.maintenanceTimer = null;
		}
		this.rooms.delete(connection);
		if (wasReady) {
			this.rpc.removePeer(connection);
			this.broadcastRouteUpdate(connection.networkName);
		}
		disposeConnection(connection);
	}

	private broadcastRouteUpdate(networkName: string, excludePeerId?: number): void {
		for (const peer of this.rooms.peers(networkName)) {
			if (peer.peerId === excludePeerId || peer.phase !== "ready") continue;
			try {
				this.rpc.sendRouteUpdate(peer, false);
			} catch (error) {
				console.error("route synchronization failed", {
					networkName: peer.networkName,
					peerId: peer.peerId,
					error: errorMessage(error),
				});
				this.close(peer, 1011, "route synchronization failed");
			}
		}
	}

	private findPeer(networkName: string, peerId: number): Connection | undefined {
		return this.rooms.get(networkName, peerId);
	}

	private scheduleMaintenance(): void {
		if (this.maintenanceTimer || this.connections.size === 0) return;
		this.maintenanceTimer = setTimeout(() => {
			this.maintenanceTimer = null;
			const now = Date.now();
			for (const failure of this.rpc.cleanExpired(now)) {
				console.error("route synchronization retry failed", {
					networkName: failure.peer.networkName,
					peerId: failure.peer.peerId,
					error: failure.error.message,
				});
				const connection = this.findPeer(failure.peer.networkName, failure.peer.peerId);
				if (connection) this.close(connection, 1011, "route synchronization retry failed");
			}
			for (const connection of this.connections.values()) {
				if (connection.phase !== "ready") continue;
				try {
					this.rpc.maintainPeer(connection, now);
				} catch (error) {
					console.error("route synchronization maintenance failed", {
						networkName: connection.networkName,
						peerId: connection.peerId,
						error: errorMessage(error),
					});
					this.close(connection, 1011, "route synchronization maintenance failed");
				}
			}
			this.scheduleMaintenance();
		}, 10_000);
	}

	private failConnection(connection: Connection, error: unknown): void {
		console.warn("EasyTier connection rejected", {
			networkName: connection.networkName || undefined,
			peerId: connection.peerId || undefined,
			error: errorMessage(error),
		});
		this.close(connection, 4401, "EasyTier authentication or protocol error");
	}

	private close(connection: Connection, code: number, reason: string): void {
		if (connection.phase === "closed") return;
		try {
			connection.socket.close(code, reason.slice(0, 120));
		} finally {
			this.removeConnection(connection);
		}
	}
}
