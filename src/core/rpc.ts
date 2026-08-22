import { WasmRpcCore } from "../wasm";
import { PacketType } from "./constants";
import { createPacket } from "./packet";

export interface RpcPeer {
	peerId: number;
	networkName: string;
	serverSessionId: bigint;
	remotePublicKey: Uint8Array;
	encrypt(packet: Uint8Array): Uint8Array;
	send(packet: Uint8Array): void;
}

interface RouteSyncState {
	peer: RpcPeer;
	inFlight: boolean;
	dirty: boolean;
	forceFull: boolean;
	sentAt: number;
	lastCompletedAt: number;
}

interface RouteSyncFailure {
	peer: RpcPeer;
	error: Error;
}

const ROUTE_SYNC_TIMEOUT_MS = 3_000;
const ROUTE_MAINTENANCE_INTERVAL_MS = 10_000;

export class EasyTierRpc {
	private readonly core: WasmRpcCore;
	private readonly routeSyncStates = new Map<string, RouteSyncState>();
	private readonly serverPeerId: number;

	constructor(publicKey: Uint8Array, hostname: string, serverPeerId: number) {
		this.core = new WasmRpcCore(publicKey, hostname, serverPeerId);
		this.serverPeerId = serverPeerId;
	}

	addPeer(peer: RpcPeer): void {
		this.core.add_peer(peer.networkName, peer.peerId, peer.remotePublicKey);
		this.routeSyncStates.delete(routeSyncKey(peer));
	}

	addLegacyPeer(peer: RpcPeer): void {
		this.core.add_peer_legacy(peer.networkName, peer.peerId);
		this.routeSyncStates.delete(routeSyncKey(peer));
	}

	removePeer(peer: RpcPeer): void {
		this.core.remove_peer(peer.networkName, peer.peerId);
		this.routeSyncStates.delete(routeSyncKey(peer));
	}

	cleanExpired(now: number): RouteSyncFailure[] {
		this.core.clean_expired(BigInt(now));
		const failures: RouteSyncFailure[] = [];
		for (const state of this.routeSyncStates.values()) {
			if (!state.inFlight || now - state.sentAt <= ROUTE_SYNC_TIMEOUT_MS) continue;
			state.inFlight = false;
			state.dirty = true;
			state.forceFull = true;
			try {
				this.flushRouteUpdate(state, now);
			} catch (error) {
				failures.push({
					peer: state.peer,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
		return failures;
	}

	handleRequest(
		peer: RpcPeer,
		payload: Uint8Array,
	): "handled" | "route" | "route-session" | "pending" {
		const result = this.core.handle_request(
			peer.networkName,
			peer.peerId,
			payload,
			BigInt(Date.now()),
		);
		if (result[0] === 0) return "pending";
		if (result.length === 1) throw new Error("WASM RPC core returned an empty response");
		this.sendControl(peer, PacketType.RpcResp, result.subarray(1));
		if (result[0] === 2) {
			this.sendRouteUpdate(peer, false);
			return "route";
		}
		if (result[0] === 3) {
			this.sendRouteUpdate(peer, false);
			return "route-session";
		}
		if (result[0] !== 1) throw new Error(`WASM RPC core returned unknown result ${result[0]}`);
		return "handled";
	}

	handleResponse(peer: RpcPeer, payload: Uint8Array): void {
		const complete = this.core.handle_response(
			peer.networkName,
			peer.peerId,
			payload,
			BigInt(Date.now()),
		);
		if (!complete) return;
		const state = this.routeSyncStates.get(routeSyncKey(peer));
		if (!state) return;
		state.inFlight = false;
		state.sentAt = 0;
		state.lastCompletedAt = Date.now();
		if (state.dirty || state.forceFull) this.flushRouteUpdate(state, Date.now());
	}

	maintainPeer(peer: RpcPeer, now: number): void {
		const state = this.routeSyncStates.get(routeSyncKey(peer));
		if (
			state === undefined ||
			state.inFlight ||
			now - state.lastCompletedAt < ROUTE_MAINTENANCE_INTERVAL_MS
		) {
			return;
		}
		this.sendRouteUpdate(peer, false);
	}

	sendRouteUpdate(peer: RpcPeer, forceFull: boolean): void {
		const key = routeSyncKey(peer);
		let state = this.routeSyncStates.get(key);
		if (!state) {
			state = {
				peer,
				inFlight: false,
				dirty: false,
				forceFull: false,
				sentAt: 0,
				lastCompletedAt: 0,
			};
			this.routeSyncStates.set(key, state);
		}
		state.peer = peer;
		state.dirty = true;
		state.forceFull ||= forceFull;
		this.flushRouteUpdate(state, Date.now());
	}

	private flushRouteUpdate(state: RouteSyncState, now: number): void {
		if (state.inFlight || (!state.dirty && !state.forceFull)) return;
		const forceFull = state.forceFull;
		state.dirty = false;
		state.forceFull = false;
		const packet = this.core.build_route_update(
			state.peer.networkName,
			state.peer.peerId,
			state.peer.serverSessionId,
			forceFull,
			BigInt(now),
		);
		state.inFlight = true;
		state.sentAt = now;
		try {
			this.sendControl(state.peer, PacketType.RpcReq, packet);
		} catch (error) {
			state.inFlight = false;
			state.dirty = true;
			state.forceFull ||= forceFull;
			throw error;
		}
	}

	private sendControl(peer: RpcPeer, packetType: PacketType, payload: Uint8Array): void {
		const clear = createPacket(this.serverPeerId, peer.peerId, packetType, payload);
		peer.send(peer.encrypt(clear));
	}
}

function routeSyncKey(peer: RpcPeer): string {
	return JSON.stringify([peer.networkName, peer.peerId]);
}
