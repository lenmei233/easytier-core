import { describe, expect, it } from "vitest";
import {
	buildLegacyHandshakeResponse,
	parseLegacyHandshake,
} from "../src/core/legacy";

function encodeVarint(value: number): number[] {
	const bytes: number[] = [];
	let remaining = BigInt(value);
	while (remaining >= 0x80n) {
		bytes.push(Number((remaining & 0x7fn) | 0x80n));
		remaining >>= 7n;
	}
	bytes.push(Number(remaining));
	return bytes;
}

function fieldTag(fieldNumber: number, wireType: number): number[] {
	return encodeVarint((fieldNumber << 3) | wireType);
}

// 模拟 easytier-core 发出的握手请求（peer_rpc.HandshakeRequest）
function buildClientHandshake(options: {
	magic?: number;
	peerId: number;
	version?: number;
	networkName: string;
	digestLength?: number;
}): Uint8Array {
	const chunks: number[] = [];
	chunks.push(...fieldTag(1, 0), ...encodeVarint(options.magic ?? 0xd1e1a5e1));
	chunks.push(...fieldTag(2, 0), ...encodeVarint(options.peerId));
	chunks.push(...fieldTag(3, 0), ...encodeVarint(options.version ?? 1));
	const name = new TextEncoder().encode(options.networkName);
	chunks.push(...fieldTag(5, 2), ...encodeVarint(name.length), ...name);
	chunks.push(
		...fieldTag(6, 2),
		...encodeVarint(options.digestLength ?? 32),
		...new Array<number>(options.digestLength ?? 32).fill(7),
	);
	return new Uint8Array(chunks);
}

describe("legacy handshake codec", () => {
	it("parses a vanilla client handshake", () => {
		const info = parseLegacyHandshake(
			buildClientHandshake({ peerId: 0xdeadbeef, networkName: "scaffolding-mc-YNZE-U61D" }),
		);
		expect(info.peerId).toBe(0xdeadbeef);
		expect(info.networkName).toBe("scaffolding-mc-YNZE-U61D");
	});

	it("round-trips our response through the same parser", () => {
		const response = buildLegacyHandshakeResponse(10_000_001, "office");
		const info = parseLegacyHandshake(response);
		expect(info.peerId).toBe(10_000_001);
		expect(info.networkName).toBe("office");
	});

	it("encodes a 32-byte zero digest so length-only validation passes", () => {
		const response = buildLegacyHandshakeResponse(1, "net");
		let offset = 0;
		let digest: Uint8Array | undefined;
		while (offset < response.length) {
			const tag = response[offset]!;
			const field = tag >> 3;
			const wire = tag & 7;
			offset += 1;
			if (wire === 0) {
				while ((response[offset++]! & 0x80) !== 0);
			} else {
				const length = response[offset++]!;
				if (field === 6) digest = response.subarray(offset, offset + length);
				offset += length;
			}
		}
		expect(digest).toBeDefined();
		expect(digest!.length).toBe(32);
		expect(digest!.every((byte) => byte === 0)).toBe(true);
	});

	it("rejects truncated and invalid payloads", () => {
		expect(() => parseLegacyHandshake(new Uint8Array([0x0a]))).toThrow(/truncated/);
		expect(() =>
			parseLegacyHandshake(buildClientHandshake({ peerId: 0, networkName: "net" })),
		).toThrow(/my_peer_id/);
		expect(() => parseLegacyHandshake(buildClientHandshake({ peerId: 5, networkName: "" }))).toThrow(
			/network_name/,
		);
	});

	it("accepts multi-byte varint peer ids and long network names", () => {
		const name = "n".repeat(255);
		const info = parseLegacyHandshake(buildClientHandshake({ peerId: 4_294_967_295, networkName: name }));
		expect(info.peerId).toBe(4_294_967_295);
		expect(info.networkName).toBe(name);
	});
});
