import { describe, expect, it } from "vitest";
import { ENCRYPTED_FLAG, PacketType } from "../src/core/constants";
import {
	bumpForwardCounter,
	createPacket,
	incrementForwardCounter,
	parsePacket,
	readHeader,
} from "../src/core/packet";

describe("EasyTier packet framing", () => {
	it("uses the upstream 16-byte little-endian peer-manager header", () => {
		const frame = createPacket(0x10203040, 0x50607080, PacketType.RpcReq, new Uint8Array([1, 2, 3]));
		const { header, payload } = parsePacket(frame);
		expect(header).toMatchObject({
			fromPeerId: 0x10203040,
			toPeerId: 0x50607080,
			packetType: PacketType.RpcReq,
			payloadLength: 3,
		});
		expect([...payload]).toEqual([1, 2, 3]);
	});

	it("increments the forwarding counter without mutating the source", () => {
		const source = createPacket(1, 2, PacketType.Data, new Uint8Array([9]));
		const forwarded = incrementForwardCounter(source);
		expect(source[10]).toBe(1);
		expect(forwarded[10]).toBe(2);
	});

	it("rejects malformed plaintext lengths", () => {
		const frame = createPacket(1, 2, PacketType.Data, new Uint8Array([9]));
		new DataView(frame.buffer).setUint32(12, 99, true);
		expect(() => parsePacket(frame)).toThrow(/payload length/);
	});

	it("readHeader matches parsePacket on every field", () => {
		const frame = createPacket(0x11223344, 0x55667788, PacketType.RpcReq, new Uint8Array([1, 2]));
		const parsed = parsePacket(frame);
		const raw = readHeader(frame);
		expect(raw).toEqual({
			fromPeerId: parsed.header.fromPeerId,
			toPeerId: parsed.header.toPeerId,
			packetType: parsed.header.packetType,
			flags: parsed.header.flags,
			forwardCounter: parsed.header.forwardCounter,
			reserved: parsed.header.reserved,
			payloadLength: parsed.header.payloadLength,
		});
	});

	it("bumpForwardCounter mutates in place and rejects hop overflow", () => {
		const frame = createPacket(1, 2, PacketType.Data, new Uint8Array([7]));
		frame[10] = 3;
		bumpForwardCounter(frame);
		expect(frame[10]).toBe(4);
		frame[10] = 8;
		expect(() => bumpForwardCounter(frame)).toThrow(/hop limit/);
	});

	it("readHeader validates encrypted frame lengths", () => {
		const frame = createPacket(1, 2, PacketType.Data, new Uint8Array([9]));
		frame[9] |= ENCRYPTED_FLAG;
		expect(() => readHeader(frame)).toThrow(/payload length mismatch/);
	});
});
