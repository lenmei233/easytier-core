interface RoomConfig {
	network_secret: string;
}

export interface ServerConfig {
	rooms: ReadonlyMap<string, RoomConfig>;
	hostname: string;
	localPrivateKey: string;
	localPublicKey: string;
	localPublicKeyBytes: Uint8Array;
	maxFrameBytes: number;
	allowLegacy: boolean;
}

export interface EasyTierEnv {
	EASYTIER_SERVER: DurableObjectNamespace;
	EASYTIER_NETWORKS: string;
	LOCAL_PRIVATE_KEY: string;
	LOCAL_PUBLIC_KEY: string;
	EASYTIER_HOSTNAME?: string;
	MAX_FRAME_BYTES?: string;
	EASYTIER_ENABLE_LEGACY?: string;
}

const UTF8_ENCODER = new TextEncoder();

export function readServerConfig(env: EasyTierEnv): ServerConfig {
	if (!env.LOCAL_PRIVATE_KEY || !env.LOCAL_PUBLIC_KEY) {
		throw new Error("secure_mode requires LOCAL_PRIVATE_KEY and LOCAL_PUBLIC_KEY");
	}
	const privateBytes = decodeBase64Key(env.LOCAL_PRIVATE_KEY, "LOCAL_PRIVATE_KEY");
	const publicBytes = decodeBase64Key(env.LOCAL_PUBLIC_KEY, "LOCAL_PUBLIC_KEY");
	if (privateBytes.every((byte) => byte === 0) || publicBytes.every((byte) => byte === 0)) {
		throw new Error("secure_mode keys must not be all-zero values");
	}

	let input: unknown;
	try {
		input = JSON.parse(env.EASYTIER_NETWORKS ?? "[]");
	} catch {
		throw new Error("EASYTIER_NETWORKS must be a JSON array");
	}
	if (!Array.isArray(input)) {
		throw new Error("EASYTIER_NETWORKS must be a JSON array");
	}
	const allowLegacy = env.EASYTIER_ENABLE_LEGACY === "true";
	if (input.length === 0 && !allowLegacy) {
		throw new Error("EASYTIER_NETWORKS must configure at least one network");
	}
	const rooms = new Map<string, RoomConfig>();
	for (const candidate of input) {
		if (!isRecord(candidate)) {
			throw new Error("each EASYTIER_NETWORKS entry must be an object");
		}
		const networkName = candidate.network_name;
		const networkSecret = candidate.network_secret;
		if (typeof networkName !== "string") {
			throw new Error("each room requires a non-empty network_name of at most 255 bytes");
		}
		const networkNameBytes = UTF8_ENCODER.encode(networkName).byteLength;
		if (networkNameBytes === 0 || networkNameBytes > 255) {
			throw new Error("each room requires a non-empty network_name of at most 255 bytes");
		}
		if (typeof networkSecret !== "string" || networkSecret.length === 0) {
			throw new Error(`room ${networkName} requires a non-empty network_secret`);
		}
		if (rooms.has(networkName)) {
			throw new Error(`duplicate network_name: ${networkName}`);
		}
		rooms.set(networkName, { network_secret: networkSecret });
	}

	const maxFrameBytes = Number(env.MAX_FRAME_BYTES ?? 1_048_576);
	if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 16_777_216) {
		throw new Error("MAX_FRAME_BYTES must be an integer between 1024 and 16777216");
	}
	const hostname = env.EASYTIER_HOSTNAME ?? "edge";
	if (
		typeof hostname !== "string" ||
		hostname.length === 0 ||
		UTF8_ENCODER.encode(hostname).byteLength > 255
	) {
		throw new Error("EASYTIER_HOSTNAME must be a non-empty string of at most 255 bytes");
	}

	return {
		rooms,
		hostname,
		localPrivateKey: env.LOCAL_PRIVATE_KEY,
		localPublicKey: env.LOCAL_PUBLIC_KEY,
		localPublicKeyBytes: publicBytes,
		maxFrameBytes,
		allowLegacy,
	};
}

function decodeBase64Key(value: string, name: string): Uint8Array {
	let decoded: Uint8Array;
	try {
		const binary = atob(value);
		decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new Error(`${name} must be valid base64`);
	}
	if (decoded.byteLength !== 32) {
		throw new Error(`${name} must decode to exactly 32 bytes`);
	}
	return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
