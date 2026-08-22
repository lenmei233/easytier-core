// EasyTier legacy 握手（peer_rpc.proto HandshakeRequest）：
// magic=1 u32, my_peer_id=2 u32, version=3 u32, features=4 repeated string,
// network_name=5 string, network_secret_digest=6 bytes
const HANDSHAKE_MAGIC = 0xd1e1a5e1;
const HANDSHAKE_VERSION = 1;
const DIGEST_LENGTH = 32;
const MAX_NETWORK_NAME_BYTES = 255;

export interface LegacyHandshakeInfo {
	peerId: number;
	networkName: string;
}

export function parseLegacyHandshake(payload: Uint8Array): LegacyHandshakeInfo {
	let peerId: number | undefined;
	let networkName: string | undefined;
	let offset = 0;
	while (offset < payload.length) {
		const tag = readVarint(payload, offset);
		if (tag === null) throw new Error("legacy handshake contains a truncated field tag");
		offset = tag.offset;
		const fieldNumber = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 7n);		if (wireType === 0) {
			const value = readVarint(payload, offset);
			if (value === null) throw new Error("legacy handshake contains a truncated varint");
			offset = value.offset;
			if (fieldNumber === 2) peerId = Number(value.value);
		} else if (wireType === 2) {
			const length = readVarint(payload, offset);
			if (length === null) throw new Error("legacy handshake contains a truncated length");
			offset = length.offset;
			const end = offset + Number(length.value);
			if (end > payload.length) {
				throw new Error("legacy handshake contains an out-of-bounds field");
			}
			if (fieldNumber === 5 && networkName === undefined) {
				networkName = new TextDecoder().decode(payload.subarray(offset, end));
			}
			offset = end;
		} else if (wireType === 1) {
			offset += 8;
		} else if (wireType === 5) {
			offset += 4;
		} else {
			throw new Error(`legacy handshake uses unsupported wire type ${wireType}`);
		}
	}

	if (peerId === undefined || !Number.isSafeInteger(peerId) || peerId <= 0 || peerId > 0xffffffff) {
		throw new Error("legacy handshake is missing a valid my_peer_id");
	}
	if (networkName === undefined || networkName.length === 0) {
		throw new Error("legacy handshake is missing a non-empty network_name");
	}
	if (new TextEncoder().encode(networkName).byteLength > MAX_NETWORK_NAME_BYTES) {
		throw new Error("legacy handshake network_name exceeds 255 bytes");
	}
	return { peerId, networkName };
}

export function buildLegacyHandshakeResponse(
	relayPeerId: number,
	networkName: string,
): Uint8Array {
	const parts: number[] = [];
	parts.push(...writeVarint((1 << 3) | 0), ...writeVarint(HANDSHAKE_MAGIC));
	parts.push(...writeVarint((2 << 3) | 0), ...writeVarint(relayPeerId));
	parts.push(...writeVarint((3 << 3) | 0), ...writeVarint(HANDSHAKE_VERSION));
	const nameBytes = new TextEncoder().encode(networkName);
	parts.push(...writeVarint((5 << 3) | 2), ...writeVarint(nameBytes.length), ...nameBytes);
	parts.push(
		...writeVarint((6 << 3) | 2),
		...writeVarint(DIGEST_LENGTH),
		...new Array<number>(DIGEST_LENGTH).fill(0),
	);
	return new Uint8Array(parts);
}

interface Varint {
	value: bigint;
	offset: number;
}

function readVarint(bytes: Uint8Array, offset: number): Varint | null {
	let result = 0n;
	let shift = 0n;
	let position = offset;
	while (position < bytes.length) {
		const byte = bytes[position]!;
		position += 1;
		result |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value: result, offset: position };
		shift += 7n;
		if (shift > 63n) return null;
	}
	return null;
}

function writeVarint(value: number): number[] {
	const bytes: number[] = [];
	let remaining = BigInt(value);
	while (remaining >= 0x80n) {
		bytes.push(Number((remaining & 0x7fn) | 0x80n));
		remaining >>= 7n;
	}
	bytes.push(Number(remaining));
	return bytes;
}
