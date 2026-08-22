use std::collections::{BTreeSet, HashMap};

use prost::Message;
use wasm_bindgen::JsValue;

use crate::proto::peer_rpc::{
    PeerIdVersion, RouteConnBitmap, RouteConnPeerList, RoutePeerInfo, RoutePeerInfos,
    SyncRouteInfoRequest, SyncRouteInfoResponse, route_conn_peer_list,
    sync_route_info_request::ConnInfo,
};

pub type PeerId = u32;
pub type Version = u32;
pub type SessionId = u64;

pub(crate) struct RouteSyncOutcome {
    pub(crate) response: Vec<u8>,
    pub(crate) route_changed: bool,
    pub(crate) session_changed: bool,
}

pub(crate) struct RouteUpdate {
    pub(crate) payload: Vec<u8>,
    pub(crate) peer_info_versions: Vec<(PeerId, Version)>,
    pub(crate) topology_version: Option<u64>,
}

const EASYTIER_VERSION: &str = "2.6.4-8428a89d-edge";
const MAX_LEGACY_BITMAP_PEERS: usize = 8_192;
const SAVED_ROUTE_VERSION_TTL_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, Default)]
struct SavedVersion {
    version: Version,
    touched_at_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct SessionState {
    my_session_id: Option<SessionId>,
    dst_session_id: Option<SessionId>,
    we_are_initiator: bool,
    peer_info_ver_map: HashMap<PeerId, SavedVersion>,
    foreign_net_ver: u32,
    last_touch_ms: u64,
    last_topology_version: u64,
    last_topology_touch_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct RouteGroupData {
    peers: BTreeSet<PeerId>, // 房间内已知的节点标识
    peer_infos: HashMap<PeerId, RoutePeerInfo>,
    authenticated_peer_keys: HashMap<PeerId, [u8; 32]>,
    sessions: HashMap<PeerId, SessionState>,
    peer_conn_versions: HashMap<PeerId, Version>,
    topology_version: u64,
    cached_conn_bitmap: Option<(u64, RouteConnBitmap)>,
    cached_conn_peer_list: Option<(u64, RouteConnPeerList)>,
    my_info: RoutePeerInfo,
    my_info_version: Version,
}

/// EasyTier 路由状态管理器，逻辑移植自 peer_ospf_route.rs。
pub(crate) struct RouteState {
    groups: HashMap<String, RouteGroupData>,
    my_peer_id: PeerId,
}

impl RouteState {
    pub(crate) fn new(my_peer_id: PeerId) -> Self {
        RouteState {
            groups: HashMap::new(),
            my_peer_id,
        }
    }

    fn now_ms() -> u64 {
        js_sys::Date::now() as u64
    }

    fn random_u32() -> u32 {
        (js_sys::Math::random() * (u32::MAX as f64)) as u32
    }

    fn random_u64() -> u64 {
        let hi = Self::random_u32() as u64;
        let lo = Self::random_u32() as u64;
        (hi << 32) | lo
    }

    fn random_uuid() -> crate::proto::common::Uuid {
        crate::proto::common::Uuid {
            part1: Self::random_u32(),
            part2: Self::random_u32(),
            part3: Self::random_u32(),
            part4: Self::random_u32(),
        }
    }

    fn ensure_group(&mut self, group_key: &str) -> &mut RouteGroupData {
        let my_peer_id = self.my_peer_id;
        self.groups.entry(group_key.to_string()).or_insert_with(|| {
            let mut my_info = RoutePeerInfo::default();
            my_info.peer_id = my_peer_id;
            my_info.inst_id = Some(Self::random_uuid());
            my_info.cost = 0;
            my_info.version = 1;
            my_info.network_length = 24;
            my_info.easytier_version = EASYTIER_VERSION.to_string();
            my_info.hostname = Some("edge".to_string());
            my_info.peer_route_id = Self::random_u64();
            my_info.feature_flag = Some(crate::proto::common::PeerFeatureFlag {
                is_public_server: true,
                // 本节点是实际后备中继，而非仅用于发现的节点。
                // 客户端仍可建立成本更低的点对点链路并迁移流量。
                avoid_relay_data: false,
                kcp_input: false,
                no_relay_kcp: false,
                support_conn_list_sync: true,
                disable_p2p: true,
                ..Default::default()
            });
            RouteGroupData {
                peers: BTreeSet::new(),
                peer_infos: HashMap::new(),
                authenticated_peer_keys: HashMap::new(),
                sessions: HashMap::new(),
                peer_conn_versions: HashMap::new(),
                topology_version: 1,
                cached_conn_bitmap: None,
                cached_conn_peer_list: None,
                my_info,
                my_info_version: 1,
            }
        })
    }

    pub(crate) fn add_peer(
        &mut self,
        group_key: &str,
        peer_id: PeerId,
        public_key: &[u8],
    ) -> Result<(), JsValue> {
        let public_key: [u8; 32] = public_key
            .try_into()
            .map_err(|_| JsValue::from_str("authenticated peer public key must be 32 bytes"))?;
        let my_peer_id = self.my_peer_id;
        let g = self.ensure_group(group_key);
        if g.authenticated_peer_keys
            .get(&peer_id)
            .is_some_and(|current| current != &public_key)
        {
            return Err(JsValue::from_str(
                "peer id is already bound to another authenticated public key",
            ));
        }
        g.authenticated_peer_keys.insert(peer_id, public_key);
        let is_new = g.peers.insert(peer_id);
        if is_new {
            Self::bump_all_conn_versions(g, my_peer_id);
        }
        Ok(())
    }

    pub(crate) fn add_peer_legacy(&mut self, group_key: &str, peer_id: PeerId) {
        let my_peer_id = self.my_peer_id;
        let g = self.ensure_group(group_key);
        let is_new = g.peers.insert(peer_id);
        if is_new {
            Self::bump_all_conn_versions(g, my_peer_id);
        }
    }

    pub(crate) fn remove_peer(&mut self, group_key: &str, peer_id: PeerId) {
        let my_peer_id = self.my_peer_id;
        let g = self.ensure_group(group_key);
        let was_present = g.peers.remove(&peer_id);
        let had_info = g.peer_infos.remove(&peer_id).is_some();
        g.authenticated_peer_keys.remove(&peer_id);
        g.sessions.remove(&peer_id);
        g.peer_conn_versions.remove(&peer_id);
        for session in g.sessions.values_mut() {
            session.peer_info_ver_map.remove(&peer_id);
            session.last_topology_version = 0;
        }
        if was_present || had_info {
            Self::bump_all_conn_versions(g, my_peer_id);
        }
    }

    pub(crate) fn on_route_session_ack(
        &mut self,
        group_key: &str,
        peer_id: PeerId,
        their_session_id: SessionId,
        we_are_initiator: bool,
    ) {
        let g = self.ensure_group(group_key);
        let s = g.sessions.entry(peer_id).or_default();
        if s.dst_session_id != Some(their_session_id) {
            s.peer_info_ver_map.clear();
            s.foreign_net_ver = 0;
            s.last_topology_version = 0;
        }
        s.dst_session_id = Some(their_session_id);
        s.we_are_initiator = we_are_initiator;
        s.last_touch_ms = Self::now_ms();
    }

    pub(crate) fn commit_route_update(
        &mut self,
        group_key: &str,
        peer_id: PeerId,
        peer_info_versions: &[(PeerId, Version)],
        topology_version: Option<u64>,
    ) {
        let g = self.ensure_group(group_key);
        let session = g.sessions.entry(peer_id).or_default();
        let current_ms = Self::now_ms();
        for (sent_peer_id, version) in peer_info_versions {
            session
                .peer_info_ver_map
                .entry(*sent_peer_id)
                .and_modify(|saved| {
                    saved.version = saved.version.max(*version);
                    saved.touched_at_ms = current_ms;
                })
                .or_insert(SavedVersion {
                    version: *version,
                    touched_at_ms: current_ms,
                });
        }
        if let Some(version) = topology_version {
            session.last_topology_version = session.last_topology_version.max(version);
            session.last_topology_touch_ms = current_ms;
        }
        session.last_touch_ms = current_ms;
    }

    pub(crate) fn set_my_info_field(
        &mut self,
        group_key: &str,
        field: &str,
        value: &str,
    ) -> Result<(), JsValue> {
        let g = self.ensure_group(group_key);
        match field {
            "hostname" => g.my_info.hostname = Some(value.to_string()),
            "network_length" => {
                g.my_info.network_length = value
                    .parse()
                    .map_err(|_| JsValue::from_str("invalid network_length"))?;
            }
            "ipv4_addr" => {
                let addr: u32 = value
                    .parse()
                    .map_err(|_| JsValue::from_str("invalid ipv4_addr"))?;
                g.my_info.ipv4_addr = Some(crate::proto::common::Ipv4Addr { addr });
            }
            _ => return Err(JsValue::from_str("unknown field")),
        }
        g.my_info_version += 1;
        g.my_info.version = g.my_info_version;
        Ok(())
    }

    /// 在 OSPF 路由信息中发布稳定的安全模式公钥，供节点固定中继身份并建立端到端会话。
    pub(crate) fn set_my_noise_public_key(
        &mut self,
        group_key: &str,
        public_key: &[u8],
    ) -> Result<(), JsValue> {
        if public_key.len() != 32 {
            return Err(JsValue::from_str("Noise public key must be 32 bytes"));
        }
        let g = self.ensure_group(group_key);
        g.my_info.noise_static_pubkey = public_key.to_vec();
        g.my_info_version += 1;
        g.my_info.version = g.my_info_version;
        Ok(())
    }

    /// 生成发往目标节点的 SyncRouteInfoRequest 负载。
    pub(crate) fn build_sync_route_info_request(
        &mut self,
        group_key: &str,
        target_peer_id: PeerId,
        server_session_id: SessionId,
        we_are_initiator: bool,
        force_full: bool,
    ) -> Result<RouteUpdate, JsValue> {
        let my_peer_id = self.my_peer_id;
        let g = self.ensure_group(group_key);

        // 先更新会话，避免与后续可变借用冲突。
        {
            let session = g.sessions.entry(target_peer_id).or_default();
            session.my_session_id = Some(server_session_id);
            session.last_touch_ms = Self::now_ms();
        }

        let force_full_local = {
            let session = g.sessions.get(&target_peer_id);
            force_full || session.map(|s| s.dst_session_id.is_none()).unwrap_or(true)
        };

        let mut all_peers: BTreeSet<PeerId> = g.peers.clone();
        all_peers.insert(my_peer_id);
        all_peers.insert(target_peer_id);

        let mut relevant_peers = vec![my_peer_id];
        for pid in all_peers.iter().filter(|&&p| p != my_peer_id) {
            relevant_peers.push(*pid);
        }
        relevant_peers.sort();

        let mut peer_infos_items = Vec::new();
        let mut peer_info_versions = Vec::new();
        let current_ms = Self::now_ms();
        {
            let session = g.sessions.entry(target_peer_id).or_default();
            for pid in &relevant_peers {
                if *pid == target_peer_id {
                    continue;
                }
                let info = if *pid == my_peer_id {
                    Some(&g.my_info)
                } else {
                    g.peer_infos.get(pid)
                };
                let Some(info) = info else {
                    continue;
                };
                let version = info.version.max(1);
                let prev = if force_full_local {
                    0
                } else {
                    session
                        .peer_info_ver_map
                        .get(pid)
                        .filter(|saved| {
                            current_ms.saturating_sub(saved.touched_at_ms)
                                < SAVED_ROUTE_VERSION_TTL_MS
                        })
                        .map_or(0, |saved| saved.version)
                };
                if force_full_local || version > prev {
                    peer_infos_items.push(info.clone());
                    peer_info_versions.push((*pid, version));
                }
            }
        }

        let supports_conn_list = g
            .peer_infos
            .get(&target_peer_id)
            .and_then(|info| info.feature_flag.as_ref())
            .is_some_and(|flag| flag.support_conn_list_sync);
        let conn_info = Self::build_conn_info(
            g,
            &relevant_peers,
            target_peer_id,
            supports_conn_list,
            my_peer_id,
        )?;
        let topology_version = conn_info.as_ref().map(|_| g.topology_version);

        // 每个房间都是独立的 EasyTier 网络。ForeignNetworkRouteInfo 仅用于公共共享节点互联，
        // 在此发布会破坏房间的强隔离边界。
        let foreign_network_infos = None;

        let req = SyncRouteInfoRequest {
            my_peer_id,
            my_session_id: server_session_id,
            is_initiator: we_are_initiator,
            peer_infos: if peer_infos_items.is_empty() {
                None
            } else {
                Some(RoutePeerInfos {
                    items: peer_infos_items,
                })
            },
            conn_info,
            foreign_network_infos,
        };

        Ok(RouteUpdate {
            payload: prost::Message::encode_to_vec(&req),
            peer_info_versions,
            topology_version,
        })
    }

    /// 处理收到的 SyncRouteInfoRequest 并生成 SyncRouteInfoResponse。
    pub(crate) fn handle_sync_route_info_request(
        &mut self,
        group_key: &str,
        from_peer_id: PeerId,
        request_bytes: &[u8],
    ) -> Result<RouteSyncOutcome, JsValue> {
        let my_peer_id = self.my_peer_id;
        let req = SyncRouteInfoRequest::decode(request_bytes).map_err(|e| {
            JsValue::from_str(&format!("decode SyncRouteInfoRequest failed: {}", e))
        })?;
        if req.my_peer_id != from_peer_id {
            return Err(JsValue::from_str(
                "SyncRouteInfoRequest peer id does not match the authenticated connection",
            ));
        }

        let g = self.ensure_group(group_key);

        let session_changed = {
            let session = g.sessions.entry(from_peer_id).or_default();
            session.last_touch_ms = Self::now_ms();
            let sid = req.my_session_id;
            let changed = session.dst_session_id != Some(sid);
            if changed {
                session.peer_info_ver_map.clear();
                session.foreign_net_ver = 0;
                session.last_topology_version = 0;
            }
            session.dst_session_id = Some(sid);
            session.we_are_initiator = !req.is_initiator;
            changed
        };

        let mut route_changed = false;
        if let Some(infos) = &req.peer_infos {
            let mut need_bump = false;
            for info in &infos.items {
                // 每个连接只能发布自身路由信息，避免覆盖其他在线节点状态
                if info.peer_id != from_peer_id {
                    continue;
                }
                // legacy 对等端没有 Noise 身份，未绑定公钥的节点跳过该校验
                if let Some(authenticated_key) = g.authenticated_peer_keys.get(&from_peer_id) {
                    if info.noise_static_pubkey.as_slice() != authenticated_key.as_slice() {
                        return Err(JsValue::from_str(
                            "RoutePeerInfo public key does not match the authenticated Noise identity",
                        ));
                    }
                }
                let is_new = !g.peer_infos.contains_key(&info.peer_id);
                let instance_changed = g
                    .peer_infos
                    .get(&info.peer_id)
                    .is_some_and(|current| current.inst_id != info.inst_id);
                let should_update = instance_changed
                    || g
                        .peer_infos
                        .get(&info.peer_id)
                        .is_none_or(|current| info.version > current.version);
                if !should_update {
                    continue;
                }
                route_changed = true;
                if instance_changed {
                    for session in g.sessions.values_mut() {
                        session.peer_info_ver_map.remove(&info.peer_id);
                    }
                }
                let mut info = info.clone();
                info.last_update = Some(crate::proto::Timestamp {
                    seconds: (Self::now_ms() / 1000) as i64,
                    nanos: 0,
                });
                g.peer_infos.insert(info.peer_id, info);
                if is_new {
                    need_bump = true;
                }
            }
            if need_bump {
                Self::bump_all_conn_versions(g, my_peer_id);
            }
        }

        let server_session_id = {
            let session = g.sessions.get(&from_peer_id);
            session.and_then(|s| s.my_session_id).unwrap_or(1)
        };
        let resp = SyncRouteInfoResponse {
            is_initiator: !req.is_initiator,
            session_id: server_session_id,
            error: None,
        };

        Ok(RouteSyncOutcome {
            response: prost::Message::encode_to_vec(&resp),
            route_changed,
            session_changed,
        })
    }

    // 辅助方法

    fn bump_all_conn_versions(g: &mut RouteGroupData, my_peer_id: PeerId) {
        let all: BTreeSet<PeerId> = g.peers.iter().chain(g.peer_infos.keys()).copied().collect();
        for pid in all {
            let v = g.peer_conn_versions.get(&pid).copied().unwrap_or(1);
            g.peer_conn_versions.insert(pid, v + 1);
        }
        g.peer_conn_versions
            .entry(my_peer_id)
            .and_modify(|v| *v += 1)
            .or_insert(2);
        g.topology_version = g.topology_version.wrapping_add(1).max(1);
        g.cached_conn_bitmap = None;
        g.cached_conn_peer_list = None;
    }

    fn build_conn_info(
        g: &mut RouteGroupData,
        relevant_peers: &[PeerId],
        target_peer_id: PeerId,
        supports_conn_list: bool,
        my_peer_id: PeerId,
    ) -> Result<Option<ConnInfo>, JsValue> {
        if relevant_peers.is_empty() {
            return Ok(None);
        }

        let topology_version = g.topology_version;
        if g.sessions
            .get(&target_peer_id)
            .is_some_and(|session| {
                session.last_topology_version == topology_version
                    && Self::now_ms().saturating_sub(session.last_topology_touch_ms)
                        < SAVED_ROUTE_VERSION_TTL_MS
            })
        {
            return Ok(None);
        }

        if supports_conn_list {
            if let Some((cached_version, cached)) = &g.cached_conn_peer_list {
                if *cached_version == topology_version {
                    return Ok(Some(ConnInfo::ConnPeerList(cached.clone())));
                }
            }
        } else if let Some((cached_version, cached)) = &g.cached_conn_bitmap {
            if *cached_version == topology_version {
                return Ok(Some(ConnInfo::ConnBitmap(cached.clone())));
            }
        }

        let n = relevant_peers.len();
        let peer_id_versions: Vec<PeerIdVersion> = relevant_peers
            .iter()
            .map(|pid| PeerIdVersion {
                peer_id: *pid,
                version: g.peer_conn_versions.get(pid).copied().unwrap_or(1),
            })
            .collect();

        if supports_conn_list {
            let peer_conn_infos = peer_id_versions
                .into_iter()
                .map(|peer_id| {
                    let connected_peer_ids = if peer_id.peer_id == my_peer_id {
                        relevant_peers
                            .iter()
                            .copied()
                            .filter(|candidate| *candidate != my_peer_id)
                            .collect()
                    } else {
                        vec![my_peer_id]
                    };
                    route_conn_peer_list::PeerConnInfo {
                        peer_id: Some(peer_id),
                        connected_peer_ids,
                    }
                })
                .collect();
            let result = RouteConnPeerList { peer_conn_infos };
            g.cached_conn_peer_list = Some((topology_version, result.clone()));
            return Ok(Some(ConnInfo::ConnPeerList(result)));
        }

        if n > MAX_LEGACY_BITMAP_PEERS {
            return Err(JsValue::from_str(
                "peer does not support sparse route synchronization and the legacy bitmap limit was exceeded",
            ));
        }
        let bitmap_size = (n * n + 7) / 8;
        let mut bitmap = vec![0u8; bitmap_size];

        let idx_by_peer: HashMap<PeerId, usize> = relevant_peers
            .iter()
            .enumerate()
            .map(|(i, p)| (*p, i))
            .collect();

        let set_bit = |bitmap: &mut [u8], row: usize, col: usize| {
            let idx = row * n + col;
            bitmap[idx / 8] |= 1 << (idx % 8);
        };

        for i in 0..n {
            set_bit(&mut bitmap, i, i);
        }

        if let Some(&server_idx) = idx_by_peer.get(&my_peer_id) {
            for i in 0..n {
                if i == server_idx {
                    continue;
                }
                set_bit(&mut bitmap, server_idx, i);
                set_bit(&mut bitmap, i, server_idx);
            }
        } else {
            for i in 0..n {
                for j in 0..n {
                    set_bit(&mut bitmap, i, j);
                }
            }
        }

        let result = RouteConnBitmap {
            peer_ids: peer_id_versions,
            bitmap,
        };
        g.cached_conn_bitmap = Some((topology_version, result.clone()));
        Ok(Some(ConnInfo::ConnBitmap(result)))
    }
}
