import { SecurePeer } from "./wasm";
import { SERVER_PEER_ID } from "./core/constants";
import { type EasyTierEnv, readServerConfig } from "./core/config";
import { errorMessage } from "./runtime/errors";

export { EasyTierServer } from "./server";

// DO 创建后不会迁移位置；位置变更时换对象名以强制在新 hint 处重建
function durableObjectName(doLocation: string | undefined): string {
	return doLocation === undefined
		? "easytier-central-relay"
		: `easytier-central-relay-${doLocation}`;
}

export default {
	async fetch(request: Request, env: EasyTierEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/healthz" && request.method === "GET") {
			try {
				const config = readServerConfig(env);
				const validator = new SecurePeer(
					config.localPrivateKey,
					config.localPublicKey,
					SERVER_PEER_ID,
				);
				validator.free();
				return Response.json(
					{ ok: true, secure_mode: true, networks: config.rooms.size },
					{ headers: { "cache-control": "no-store" } },
				);
			} catch (error) {
				console.error("EasyTier configuration is invalid", {
					error: errorMessage(error),
				});
				return Response.json(
					{ ok: false, error: "invalid server configuration" },
					{ status: 503, headers: { "cache-control": "no-store" } },
				);
			}
		}

		if (url.pathname !== "/") return new Response("Not found", { status: 404 });
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", {
				status: 426,
				headers: { Upgrade: "websocket" },
			});
		}
		let config: ReturnType<typeof readServerConfig>;
		try {
			config = readServerConfig(env);
		} catch (error) {
			console.error("EasyTier configuration is invalid", {
				error: errorMessage(error),
			});
			return new Response("Server configuration is invalid", { status: 503 });
		}
		const objectId = env.EASYTIER_SERVER.idFromName(durableObjectName(config.doLocation));
		const stub = env.EASYTIER_SERVER.get(
			objectId,
			config.doLocation === undefined
				? undefined
				: { locationHint: config.doLocation as DurableObjectLocationHint },
		);
		return stub.fetch(request);
	},
} satisfies ExportedHandler<EasyTierEnv>;
