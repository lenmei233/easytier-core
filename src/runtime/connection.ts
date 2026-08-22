import { type RpcPeer } from "../core/rpc";
import { WS_OPEN } from "../core/constants";
import { type SecurePeer } from "../wasm";

export type ConnectionMode = "secure" | "legacy";
type ConnectionPhase = "undecided" | "msg1" | "msg3" | "ready" | "closed";

export interface Connection extends RpcPeer {
	socket: WebSocket;
	secure: SecurePeer | null;
	mode: ConnectionMode;
	remotePublicKey: Uint8Array;
	phase: ConnectionPhase;
	handshakeTimer: ReturnType<typeof setTimeout> | null;
	sendWindowStartedAt: number;
	sentBytesInWindow: number;
	sentFramesInWindow: number;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const SEND_WINDOW_MS = 1_000;
const MAX_SEND_BYTES_PER_WINDOW = 32 * 1024 * 1024;
const MAX_SEND_FRAMES_PER_WINDOW = 4_096;

export function createConnection(
	socket: WebSocket,
	onHandshakeTimeout: (connection: Connection) => void,
): Connection {
	const connection: Connection = {
		socket,
		secure: null,
		mode: "secure",
		remotePublicKey: new Uint8Array(),
		phase: "undecided",
		peerId: 0,
		networkName: "",
		serverSessionId: randomU64(),
		handshakeTimer: null,
		sendWindowStartedAt: Date.now(),
		sentBytesInWindow: 0,
		sentFramesInWindow: 0,
		encrypt: (packet) =>
			connection.secure ? connection.secure.encrypt_packet(packet) : packet,
		send: (packet) => sendConnection(connection, packet),
	};
	connection.handshakeTimer = setTimeout(
		() => onHandshakeTimeout(connection),
		HANDSHAKE_TIMEOUT_MS,
	);
	return connection;
}

export function completeHandshake(connection: Connection): void {
	if (connection.handshakeTimer !== null) clearTimeout(connection.handshakeTimer);
	connection.handshakeTimer = null;
	connection.phase = "ready";
}

export function disposeConnection(connection: Connection): void {
	if (connection.handshakeTimer !== null) clearTimeout(connection.handshakeTimer);
	connection.handshakeTimer = null;
	connection.secure?.free();
}

function sendConnection(connection: Connection, packet: Uint8Array): void {
	const now = Date.now();
	if (now - connection.sendWindowStartedAt >= SEND_WINDOW_MS) {
		connection.sendWindowStartedAt = now;
		connection.sentBytesInWindow = 0;
		connection.sentFramesInWindow = 0;
	}
	if (
		connection.sentBytesInWindow + packet.byteLength > MAX_SEND_BYTES_PER_WINDOW ||
		connection.sentFramesInWindow >= MAX_SEND_FRAMES_PER_WINDOW
	) {
		throw new Error("WebSocket outbound relay capacity exceeded");
	}
	if (connection.socket.readyState !== WS_OPEN) {
		throw new Error("WebSocket is not open");
	}
	connection.sentBytesInWindow += packet.byteLength;
	connection.sentFramesInWindow += 1;
	connection.socket.send(packet);
}

function randomU64(): bigint {
	const words = crypto.getRandomValues(new Uint32Array(2));
	const value = (BigInt(words[0]) << 32n) | BigInt(words[1]);
	return value === 0n ? 1n : value;
}
