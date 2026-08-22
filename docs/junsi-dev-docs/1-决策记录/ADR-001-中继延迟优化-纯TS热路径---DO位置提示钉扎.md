# ADR-001：中继延迟优化：纯TS热路径 + DO位置提示钉扎

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-08-22 |
| 决策者 | AI Agent |

## 背景

easytier-edge 中继的转发路径（client→edge→DO→edge→client）中，DO 所在位置决定 edge↔DO 一跳的 RTT。此前使用 smart placement 且对象名固定（easytier-central-relay），首个请求来源决定创建位置——冒烟测试从中国发起后 DO 落在亚太，但该行为不受控；若首次请求来自海外则国内玩家全程高延迟。同时热路径每帧调用两次 WASM（parsePacket/inspect_packet + incrementForwardCounter/prepare_forward），产生不必要的边界穿越与内存分配。用户群体以国内为主，P2P 直连对延迟不敏感，relay 是延迟敏感主路径。

## 决策

①转发热路径纯 TS 化：新增 readHeader（DataView LE 读头+长度校验）与 bumpForwardCounter（frame[10]++，>7 抛错）替换两次 WASM 调用，Ping 应答改为 frame[8]=Pong 就地改写；握手/RPC 控制路径保留 WASM。②DO 位置钉扎：新增 EASYTIER_DO_LOCATION 环境变量（合法值同 CF DurableObjectLocationHint），通过 get(id, {locationHint}) 传递；因 DO 创建后不迁移，对象名改为 easytier-central-relay-<location>，位置变更自动在新 hint 处重建新实例。默认值 apac-ne（东北亚，离国内最近）。注意：locationHint 为尽力而为非保证。

## 备选方案


### 方案 仅 smart placement
- 优点：零改动
- 缺点：国内玩家到美东 DO 的 RTT 200ms+，不可控
- 为何不选：smart placement 对首次创建位置不确定，且已创建对象不迁移

## 影响
- src/server.ts 热路径重构
- src/core/packet.ts 新增纯TS函数
- src/index.ts DO寻址逻辑 + healthz 暴露 colo/do_rtt_ms 观测字段
- src/core/config.ts 新增 EASYTIER_DO_LOCATION 校验
- wrangler.jsonc 默认 apac-se，并移除 placement.smart（见修订记录 v1.1）
- 部署后 DO 对象名将变化（旧实例自然废弃）
- 每转发帧减少2次WASM边界穿越

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|:---|:---|:---|:---|
| 2026-08-22 | v1.0 | 初版创建 | AI Agent |
| 2026-08-22 | v1.1 | 实测发现 placement.smart 会覆盖 locationHint（三种 hint 的 do_rtt 均 ~500ms）；移除 smart 后 do_rtt 从 ~500ms 降至 6ms。默认位置按入口 colo=SIN 实测定为 apac-se；中继端到端延迟 250ms→154ms（-40%） | AI Agent |
