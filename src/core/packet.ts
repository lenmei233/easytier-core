import { build_packet, inspect_packet, prepare_forward, prepare_pong } from "../wasm";
import {
	EASYTIER_HEADER_SIZE,
	ENCRYPTED_FLAG,
	MAX_FORWARD_HOPS,
} from "./constants";

interface PacketHeader {
	fromPeerId: number;
	toPeerId: number;
	packetType: number;
	flags: number;
	forwardCounter: number;
	reserved: number;
	payloadLength: number;
}

const AEAD_TAIL_SIZE = 28;

// 转发热路径专用：零拷贝读头，避免 WASM 边界穿越
export function readHeader(bytes: Uint8Array): PacketHeader {
	if (bytes.byteLength < EASYTIER_HEADER_SIZE) {
		throw new Error(`header too short: ${bytes.byteLength} < ${EASYTIER_HEADER_SIZE}`);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, EASYTIER_HEADER_SIZE);
	const payloadLength = bytes.byteLength - EASYTIER_HEADER_SIZE;
	const declared = view.getUint32(12, true);
	const expected =
		declared + ((view.getUint8(9) & ENCRYPTED_FLAG) === 0 ? 0 : AEAD_TAIL_SIZE);
	if (payloadLength !== expected) {
		throw new Error(`payload length mismatch: ${payloadLength} != ${expected}`);
	}
	return {
		fromPeerId: view.getUint32(0, true),
		toPeerId: view.getUint32(4, true),
		packetType: view.getUint8(8),
		flags: view.getUint8(9),
		forwardCounter: view.getUint8(10),
		reserved: view.getUint8(11),
		payloadLength: declared,
	};
}

// 就地递增转发计数，语义与 wasm prepare_forward 一致（>MAX 时抛错）
export function bumpForwardCounter(bytes: Uint8Array): void {
	if (bytes[10]! > MAX_FORWARD_HOPS) {
		throw new Error("EasyTier forwarding hop limit exceeded");
	}
	bytes[10] = bytes[10]! + 1;
}

export function parsePacket(bytes: Uint8Array): { header: PacketHeader; payload: Uint8Array } {
	const values = inspect_packet(bytes);
	const header: PacketHeader = {
		fromPeerId: values[0],
		toPeerId: values[1],
		packetType: values[2],
		flags: values[3],
		forwardCounter: values[4],
		reserved: values[5],
		payloadLength: values[6],
	};
	const payload = bytes.subarray(EASYTIER_HEADER_SIZE);
	return { header, payload };
}

export function createPacket(
	fromPeerId: number,
	toPeerId: number,
	packetType: number,
	payload: Uint8Array,
): Uint8Array {
	return build_packet(fromPeerId, toPeerId, packetType, payload);
}

export function incrementForwardCounter(frame: Uint8Array): Uint8Array {
	return prepare_forward(frame);
}

export function createPong(frame: Uint8Array): Uint8Array {
	return prepare_pong(frame);
}

export function toUint8Array(data: string | ArrayBuffer): Uint8Array {
	if (typeof data === "string") {
		throw new Error("EasyTier accepts binary WebSocket messages only");
	}
	return new Uint8Array(data);
}
