use std::collections::{HashMap, HashSet};

use prost::Message;
use wasm_bindgen::prelude::*;

use crate::peer_center::PeerCenter;
use crate::proto::common::{
    CompressionAlgoPb, RpcCompressionInfo, RpcDescriptor, RpcPacket, RpcRequest, RpcResponse,
};
use crate::proto::error::{
    Error as RpcError, InvalidMethodIndex, InvalidService, error::ErrorKind,
};
use crate::proto::peer_rpc::{SyncRouteInfoRequest, SyncRouteInfoResponse};
use crate::route_state::{RouteState, RouteUpdate};

const MAX_RPC_PIECES: u32 = 32_768;
const MAX_PENDING_TRANSACTIONS_PER_PEER: usize = 64;
const MAX_PENDING_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_PIECES: usize = 32_768;
const RPC_FRAGMENT_TTL_MS: u64 = 10_000;
const ROUTE_RPC_TIMEOUT_MS: u64 = 3_000;
const PEER_CENTER_TTL_SECONDS: u64 = 180;
const RESULT_HANDLED: u8 = 1;
const RESULT_ROUTE: u8 = 2;
const RESULT_ROUTE_SESSION: u8 = 3;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct RpcKey {
    network: String,
    peer_id: u32,
    transaction_id: i64,
    is_request: bool,
}

struct PendingRpc {
    total_pieces: u32,
    pieces: Vec<Option<Vec<u8>>>,
    first: Option<RpcPacket>,
    received_pieces: u32,
    body_bytes: usize,
    updated_at_ms: u64,
}

struct OutstandingRoute {
    deadline_ms: u64,
    peer_info_versions: Vec<(u32, u32)>,
    topology_version: Option<u64>,
}

enum MergedPacket {
    Pending,
    Complete(RpcPacket),
}

#[wasm_bindgen]
pub struct WasmRpcCore {
    routes: RouteState,
    peer_center: PeerCenter,
    configured_groups: HashSet<String>,
    peer_initiator: HashMap<(String, u32), bool>,
    pending: HashMap<RpcKey, PendingRpc>,
    pending_bytes: usize,
    pending_pieces: usize,
    outstanding_routes: HashMap<RpcKey, OutstandingRoute>,
    public_key: Vec<u8>,
    hostname: String,
    server_peer_id: u32,
}

#[wasm_bindgen]
impl WasmRpcCore {
    #[wasm_bindgen(constructor)]
    pub fn new(
        public_key: &[u8],
        hostname: &str,
        server_peer_id: u32,
    ) -> Result<WasmRpcCore, JsValue> {
        if public_key.len() != 32 {
            return Err(error("Noise public key must be 32 bytes"));
        }
        if server_peer_id == 0 {
            return Err(error("server peer id must not be zero"));
        }
        Ok(Self {
            routes: RouteState::new(server_peer_id),
            peer_center: PeerCenter::new(),
            configured_groups: HashSet::new(),
            peer_initiator: HashMap::new(),
            pending: HashMap::new(),
            pending_bytes: 0,
            pending_pieces: 0,
            outstanding_routes: HashMap::new(),
            public_key: public_key.to_vec(),
            hostname: hostname.to_string(),
            server_peer_id,
        })
    }

    pub fn add_peer(
        &mut self,
        network: &str,
        peer_id: u32,
        remote_public_key: &[u8],
    ) -> Result<(), JsValue> {
        self.routes
            .add_peer(network, peer_id, remote_public_key)?;
        if self.configured_groups.insert(network.to_string()) {
            self.routes
                .set_my_info_field(network, "hostname", &self.hostname)?;
            self.routes
                .set_my_noise_public_key(network, &self.public_key)?;
        }
        self.peer_initiator
            .insert((network.to_string(), peer_id), false);
        Ok(())
    }

    pub fn add_peer_legacy(&mut self, network: &str, peer_id: u32) {
        self.routes.add_peer_legacy(network, peer_id);
        self.peer_initiator
            .insert((network.to_string(), peer_id), false);
    }

    pub fn remove_peer(&mut self, network: &str, peer_id: u32) {
        self.routes.remove_peer(network, peer_id);
        self.peer_center.remove_peer(network, peer_id);
        self.peer_initiator.remove(&(network.to_string(), peer_id));

        let pending_keys: Vec<_> = self
            .pending
            .keys()
            .filter(|key| key.network == network && key.peer_id == peer_id)
            .cloned()
            .collect();
        for key in pending_keys {
            self.remove_pending(&key);
        }
        self.outstanding_routes
            .retain(|key, _| key.network != network || key.peer_id != peer_id);
    }

    pub fn handle_request(
        &mut self,
        network: &str,
        authenticated_peer_id: u32,
        payload: &[u8],
        now_ms: u64,
    ) -> Result<Vec<u8>, JsValue> {
        let packet = RpcPacket::decode(payload)
            .map_err(|err| error(&format!("decode RpcPacket failed: {err}")))?;
        self.validate_envelope(&packet, network, authenticated_peer_id, true)?;
        let packet = match self.merge_packet(network, authenticated_peer_id, packet, now_ms)? {
            MergedPacket::Pending => return Ok(vec![0]),
            MergedPacket::Complete(packet) => packet,
        };
        self.validate_compression(&packet)?;
        let descriptor = packet
            .descriptor
            .as_ref()
            .ok_or_else(|| error("RPC request is missing its descriptor"))?;
        let request = RpcRequest::decode(packet.body.as_slice())
            .map_err(|err| error(&format!("decode RpcRequest failed: {err}")))?;

        let (response_body, response_error, result) = if is_service(descriptor, "OspfRouteRpc") {
            if descriptor.method_index != 1 {
                (
                    Vec::new(),
                    Some(invalid_method_error(descriptor)),
                    RESULT_HANDLED,
                )
            } else {
                let sync = SyncRouteInfoRequest::decode(request.request.as_slice())
                    .map_err(|err| error(&format!("decode SyncRouteInfoRequest failed: {err}")))?;
                let we_are_initiator = !sync.is_initiator;
                self.peer_initiator.insert(
                    (network.to_string(), authenticated_peer_id),
                    we_are_initiator,
                );
                let outcome = self.routes.handle_sync_route_info_request(
                    network,
                    authenticated_peer_id,
                    &request.request,
                )?;
                let result = if outcome.route_changed {
                    RESULT_ROUTE
                } else if outcome.session_changed {
                    RESULT_ROUTE_SESSION
                } else {
                    RESULT_HANDLED
                };
                (outcome.response, None, result)
            }
        } else if is_service(descriptor, "PeerCenterRpc") {
            match descriptor.method_index {
                1 => (
                    self.peer_center.report_peers(
                        network,
                        authenticated_peer_id,
                        &request.request,
                    )?,
                    None,
                    RESULT_HANDLED,
                ),
                2 => (
                    self.peer_center
                        .get_global_peer_map(network, &request.request)?,
                    None,
                    RESULT_HANDLED,
                ),
                _ => (
                    Vec::new(),
                    Some(invalid_method_error(descriptor)),
                    RESULT_HANDLED,
                ),
            }
        } else {
            (
                Vec::new(),
                Some(RpcError {
                    error_kind: Some(ErrorKind::InvalidService(InvalidService {
                        service_name: descriptor.service_name.clone(),
                    })),
                }),
                RESULT_HANDLED,
            )
        };

        let response = RpcResponse {
            response: response_body,
            error: response_error,
            runtime_us: 0,
        };
        let response_packet = RpcPacket {
            from_peer: self.server_peer_id,
            to_peer: authenticated_peer_id,
            transaction_id: packet.transaction_id,
            descriptor: packet.descriptor,
            body: response.encode_to_vec(),
            is_request: false,
            total_pieces: 1,
            piece_idx: 0,
            trace_id: packet.trace_id,
            compression_info: Some(no_compression()),
        };
        Ok(result_with_packet(result, response_packet))
    }

    pub fn handle_response(
        &mut self,
        network: &str,
        authenticated_peer_id: u32,
        payload: &[u8],
        now_ms: u64,
    ) -> Result<bool, JsValue> {
        let packet = RpcPacket::decode(payload)
            .map_err(|err| error(&format!("decode RpcPacket failed: {err}")))?;
        self.validate_envelope(&packet, network, authenticated_peer_id, false)?;
        let key = rpc_key(network, authenticated_peer_id, packet.transaction_id, false);
        let deadline = self
            .outstanding_routes
            .get(&key)
            .map(|route| route.deadline_ms)
            .ok_or_else(|| error("RPC response does not match an outstanding transaction"))?;
        if now_ms > deadline {
            self.outstanding_routes.remove(&key);
            return Err(error("RPC response arrived after its transaction deadline"));
        }

        let packet = match self.merge_packet(network, authenticated_peer_id, packet, now_ms)? {
            MergedPacket::Pending => return Ok(false),
            MergedPacket::Complete(packet) => packet,
        };
        self.validate_compression(&packet)?;
        let descriptor = packet
            .descriptor
            .as_ref()
            .ok_or_else(|| error("RPC response is missing its descriptor"))?;
        if !is_service(descriptor, "OspfRouteRpc") || descriptor.method_index != 1 {
            return Err(error(
                "RPC response descriptor does not match the route request",
            ));
        }
        let response = RpcResponse::decode(packet.body.as_slice())
            .map_err(|err| error(&format!("decode RpcResponse failed: {err}")))?;
        if response.error.is_some() {
            return Err(error("peer rejected the route synchronization RPC"));
        }
        let sync = SyncRouteInfoResponse::decode(response.response.as_slice())
            .map_err(|err| error(&format!("decode SyncRouteInfoResponse failed: {err}")))?;
        if let Some(route_error) = sync.error {
            return Err(error(&format!(
                "peer returned route synchronization error {route_error}"
            )));
        }
        let outstanding = self
            .outstanding_routes
            .remove(&key)
            .ok_or_else(|| error("route synchronization transaction disappeared"))?;
        let we_are_initiator = self
            .peer_initiator
            .get(&(network.to_string(), authenticated_peer_id))
            .copied()
            .unwrap_or(true);
        self.routes.on_route_session_ack(
            network,
            authenticated_peer_id,
            sync.session_id,
            we_are_initiator,
        );
        self.routes.commit_route_update(
            network,
            authenticated_peer_id,
            &outstanding.peer_info_versions,
            outstanding.topology_version,
        );
        Ok(true)
    }

    pub fn build_route_update(
        &mut self,
        network: &str,
        peer_id: u32,
        server_session_id: u64,
        force_full: bool,
        now_ms: u64,
    ) -> Result<Vec<u8>, JsValue> {
        self.clean_rpc_state(now_ms);
        let we_are_initiator = self
            .peer_initiator
            .get(&(network.to_string(), peer_id))
            .copied()
            .unwrap_or(true);
        let RouteUpdate {
            payload,
            peer_info_versions,
            topology_version,
        } = self.routes.build_sync_route_info_request(
            network,
            peer_id,
            server_session_id,
            we_are_initiator,
            force_full,
        )?;
        let transaction_id = self.next_transaction_id(network, peer_id)?;
        let descriptor = RpcDescriptor {
            domain_name: network.to_string(),
            proto_name: "OspfRouteRpc".to_string(),
            service_name: "OspfRouteRpc".to_string(),
            method_index: 1,
        };
        let request = RpcRequest {
            request: payload,
            timeout_ms: ROUTE_RPC_TIMEOUT_MS as i32,
            ..Default::default()
        };
        let packet = RpcPacket {
            from_peer: self.server_peer_id,
            to_peer: peer_id,
            transaction_id,
            descriptor: Some(descriptor),
            body: request.encode_to_vec(),
            is_request: true,
            total_pieces: 1,
            piece_idx: 0,
            trace_id: 0,
            compression_info: Some(no_compression()),
        };
        self.outstanding_routes.insert(
            rpc_key(network, peer_id, transaction_id, false),
            OutstandingRoute {
                deadline_ms: now_ms.saturating_add(ROUTE_RPC_TIMEOUT_MS),
                peer_info_versions,
                topology_version,
            },
        );
        Ok(packet.encode_to_vec())
    }

    pub fn clean_expired(&mut self, now_ms: u64) {
        self.clean_rpc_state(now_ms);
        self.peer_center.clean_outdated(PEER_CENTER_TTL_SECONDS);
    }
}

impl WasmRpcCore {
    fn clean_rpc_state(&mut self, now_ms: u64) {
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, value)| now_ms.saturating_sub(value.updated_at_ms) >= RPC_FRAGMENT_TTL_MS)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove_pending(&key);
        }
        self.outstanding_routes
            .retain(|_, route| now_ms <= route.deadline_ms);
    }

    fn validate_envelope(
        &self,
        packet: &RpcPacket,
        network: &str,
        peer_id: u32,
        is_request: bool,
    ) -> Result<(), JsValue> {
        if packet.from_peer != peer_id || packet.to_peer != self.server_peer_id {
            return Err(error(
                "RPC protobuf envelope does not match its EasyTier header",
            ));
        }
        if packet.is_request != is_request {
            return Err(error("unexpected RPC request/response direction"));
        }
        if packet
            .descriptor
            .as_ref()
            .is_some_and(|descriptor| descriptor.domain_name != network)
        {
            return Err(error("cross-network RPC domain rejected"));
        }
        Ok(())
    }

    fn validate_compression(&self, packet: &RpcPacket) -> Result<(), JsValue> {
        if packet
            .compression_info
            .as_ref()
            .is_some_and(|compression| compression.algo > CompressionAlgoPb::None as i32)
        {
            return Err(error("compressed RPC is not negotiated by this relay"));
        }
        Ok(())
    }

    fn merge_packet(
        &mut self,
        network: &str,
        peer_id: u32,
        packet: RpcPacket,
        now_ms: u64,
    ) -> Result<MergedPacket, JsValue> {
        let total_pieces = packet.total_pieces;
        if total_pieces == 0 && packet.piece_idx == 0 {
            return Ok(MergedPacket::Complete(packet));
        }
        if total_pieces == 0 || total_pieces > MAX_RPC_PIECES || packet.piece_idx >= total_pieces {
            return Err(error("invalid fragmented RPC envelope"));
        }
        if total_pieces == 1 {
            return Ok(MergedPacket::Complete(packet));
        }
        if packet.piece_idx == 0 && packet.descriptor.is_none() {
            return Err(error(
                "fragmented RPC first piece is missing its descriptor",
            ));
        }

        self.clean_pending(now_ms);
        let key = rpc_key(network, peer_id, packet.transaction_id, packet.is_request);
        if self
            .pending
            .get(&key)
            .is_some_and(|pending| pending.total_pieces != total_pieces)
        {
            self.remove_pending(&key);
            return Err(error("fragmented RPC changed its declared piece count"));
        }
        if !self.pending.contains_key(&key) {
            let peer_pending = self
                .pending
                .keys()
                .filter(|pending_key| {
                    pending_key.network == network && pending_key.peer_id == peer_id
                })
                .count();
            if peer_pending >= MAX_PENDING_TRANSACTIONS_PER_PEER {
                return Err(error("too many pending fragmented RPC transactions"));
            }
            let declared_pieces = total_pieces as usize;
            if self.pending_pieces.saturating_add(declared_pieces) > MAX_PENDING_PIECES {
                return Err(error("pending fragmented RPC piece limit exceeded"));
            }
            self.pending.insert(
                key.clone(),
                PendingRpc {
                    total_pieces,
                    pieces: vec![None; declared_pieces],
                    first: None,
                    received_pieces: 0,
                    body_bytes: 0,
                    updated_at_ms: now_ms,
                },
            );
            self.pending_pieces += declared_pieces;
        }

        let piece_index = packet.piece_idx as usize;
        let previous_bytes = self.pending[&key].pieces[piece_index]
            .as_ref()
            .map_or(0, Vec::len);
        let next_total_bytes = self
            .pending_bytes
            .saturating_sub(previous_bytes)
            .saturating_add(packet.body.len());
        if next_total_bytes > MAX_PENDING_BYTES {
            self.remove_pending(&key);
            return Err(error("pending fragmented RPC byte limit exceeded"));
        }

        let pending = self
            .pending
            .get_mut(&key)
            .ok_or_else(|| error("pending RPC state disappeared during merge"))?;
        if pending.pieces[piece_index].is_none() {
            pending.received_pieces += 1;
        }
        pending.body_bytes = pending
            .body_bytes
            .saturating_sub(previous_bytes)
            .saturating_add(packet.body.len());
        self.pending_bytes = next_total_bytes;
        pending.pieces[piece_index] = Some(packet.body.clone());
        pending.updated_at_ms = now_ms;
        if piece_index == 0 {
            pending.first = Some(packet);
        }
        if pending.received_pieces != total_pieces {
            return Ok(MergedPacket::Pending);
        }

        let mut completed = self
            .pending
            .remove(&key)
            .ok_or_else(|| error("completed RPC state disappeared during merge"))?;
        self.pending_bytes = self.pending_bytes.saturating_sub(completed.body_bytes);
        self.pending_pieces = self
            .pending_pieces
            .saturating_sub(completed.total_pieces as usize);
        let mut first = completed
            .first
            .take()
            .ok_or_else(|| error("fragmented RPC first piece was not received"))?;
        first.body = Vec::with_capacity(completed.body_bytes);
        for piece in completed.pieces {
            first
                .body
                .extend(piece.ok_or_else(|| error("fragmented RPC contains a missing piece"))?);
        }
        first.total_pieces = 1;
        first.piece_idx = 0;
        Ok(MergedPacket::Complete(first))
    }

    fn clean_pending(&mut self, now_ms: u64) {
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, value)| now_ms.saturating_sub(value.updated_at_ms) >= RPC_FRAGMENT_TTL_MS)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove_pending(&key);
        }
    }

    fn remove_pending(&mut self, key: &RpcKey) {
        if let Some(pending) = self.pending.remove(key) {
            self.pending_bytes = self.pending_bytes.saturating_sub(pending.body_bytes);
            self.pending_pieces = self
                .pending_pieces
                .saturating_sub(pending.total_pieces as usize);
        }
    }

    fn next_transaction_id(&self, network: &str, peer_id: u32) -> Result<i64, JsValue> {
        for _ in 0..16 {
            let mut bytes = [0_u8; 8];
            getrandom::fill(&mut bytes).map_err(|err| error(&err.to_string()))?;
            let transaction_id = i64::from_le_bytes(bytes) & i64::MAX;
            let key = rpc_key(network, peer_id, transaction_id, false);
            if transaction_id != 0 && !self.outstanding_routes.contains_key(&key) {
                return Ok(transaction_id);
            }
        }
        Err(error("failed to allocate a unique RPC transaction id"))
    }
}

fn rpc_key(network: &str, peer_id: u32, transaction_id: i64, is_request: bool) -> RpcKey {
    RpcKey {
        network: network.to_string(),
        peer_id,
        transaction_id,
        is_request,
    }
}

fn no_compression() -> RpcCompressionInfo {
    RpcCompressionInfo {
        algo: CompressionAlgoPb::None as i32,
        accepted_algo: CompressionAlgoPb::None as i32,
    }
}

fn invalid_method_error(descriptor: &RpcDescriptor) -> RpcError {
    RpcError {
        error_kind: Some(ErrorKind::InvalidMethodIndex(InvalidMethodIndex {
            service_name: descriptor.service_name.clone(),
            method_index: descriptor.method_index,
        })),
    }
}

fn is_service(descriptor: &RpcDescriptor, expected: &str) -> bool {
    descriptor.service_name == expected
        && (descriptor.proto_name == format!("peer_rpc.{expected}")
            || descriptor.proto_name == "peer_rpc"
            || descriptor.proto_name == expected)
}

fn result_with_packet(result: u8, packet: RpcPacket) -> Vec<u8> {
    let encoded = packet.encode_to_vec();
    let mut output = Vec::with_capacity(encoded.len() + 1);
    output.push(result);
    output.extend(encoded);
    output
}

fn error(message: &str) -> JsValue {
    JsValue::from_str(message)
}
