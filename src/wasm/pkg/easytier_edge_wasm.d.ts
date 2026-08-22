/* tslint:disable */
/* eslint-disable */

export class SecurePeer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 为已明确配置的房间生成 EasyTier Noise 消息二。
     */
    build_msg2(network_secret: string): Uint8Array;
    /**
     * 使用 EasyTier 分代流量密钥解密节点直达服务器的数据包。
     * 节点间转发包必须绕过此方法并保持原始密文。
     */
    decrypt_packet(packet: Uint8Array): Uint8Array;
    /**
     * 加密服务器发往节点的控制包。Ping、Pong 和 Noise 帧由 TypeScript 直接发送。
     */
    encrypt_packet(packet: Uint8Array): Uint8Array;
    /**
     * 完成 Noise XX 交换并验证客户端对房间密钥的 HMAC 证明。
     * 连接在此步骤成功前不可参与路由。
     */
    finish_msg3(packet: Uint8Array): string;
    is_authenticated(): boolean;
    constructor(local_private_key_base64: string, local_public_key_base64: string, server_peer_id: number);
    /**
     * 解析 EasyTier Noise 消息一并返回连接请求的网络。
     * 网络密钥必须在此步骤之后由 TypeScript 房间白名单选择。
     */
    read_msg1(packet: Uint8Array): string;
}

export class WasmRpcCore {
    free(): void;
    [Symbol.dispose](): void;
    add_peer(network: string, peer_id: number, remote_public_key: Uint8Array): void;
    add_peer_legacy(network: string, peer_id: number): void;
    build_route_update(network: string, peer_id: number, server_session_id: bigint, force_full: boolean, now_ms: bigint): Uint8Array;
    clean_expired(now_ms: bigint): void;
    handle_request(network: string, authenticated_peer_id: number, payload: Uint8Array, now_ms: bigint): Uint8Array;
    handle_response(network: string, authenticated_peer_id: number, payload: Uint8Array, now_ms: bigint): boolean;
    constructor(public_key: Uint8Array, hostname: string, server_peer_id: number);
    remove_peer(network: string, peer_id: number): void;
}

export function build_packet(from_peer_id: number, to_peer_id: number, packet_type: number, payload: Uint8Array): Uint8Array;

export function inspect_packet(bytes: Uint8Array): Uint32Array;

export function prepare_forward(bytes: Uint8Array): Uint8Array;

export function prepare_pong(bytes: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_securepeer_free: (a: number, b: number) => void;
    readonly __wbg_wasmrpccore_free: (a: number, b: number) => void;
    readonly build_packet: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly inspect_packet: (a: number, b: number, c: number) => void;
    readonly prepare_forward: (a: number, b: number, c: number) => void;
    readonly prepare_pong: (a: number, b: number, c: number) => void;
    readonly securepeer_build_msg2: (a: number, b: number, c: number, d: number) => void;
    readonly securepeer_decrypt_packet: (a: number, b: number, c: number, d: number) => void;
    readonly securepeer_encrypt_packet: (a: number, b: number, c: number, d: number) => void;
    readonly securepeer_finish_msg3: (a: number, b: number, c: number, d: number) => void;
    readonly securepeer_is_authenticated: (a: number) => number;
    readonly securepeer_new: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly securepeer_read_msg1: (a: number, b: number, c: number, d: number) => void;
    readonly wasmrpccore_add_peer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly wasmrpccore_add_peer_legacy: (a: number, b: number, c: number, d: number) => void;
    readonly wasmrpccore_build_route_update: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: bigint) => void;
    readonly wasmrpccore_clean_expired: (a: number, b: bigint) => void;
    readonly wasmrpccore_handle_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => void;
    readonly wasmrpccore_handle_response: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => void;
    readonly wasmrpccore_new: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasmrpccore_remove_peer: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
