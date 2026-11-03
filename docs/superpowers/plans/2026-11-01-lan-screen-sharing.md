# 局域网游戏画面与语音共享 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 同一局域网内提供 1 位主播与最多 2 位观众的整屏游戏画面、游戏系统音频和双向语音共享，最终交付便携单文件程序。

**Architecture:** 每位参与者运行同一个 Go 单 EXE，并在本机 `localhost` 浏览器操作。Go 服务托管静态页面、限制房间和信令并由观众端 Go 服务桥接信令；媒体由浏览器 WebRTC 全网状 P2P 传输。屏幕采集与麦克风保持独立，系统音频隔离未实机确认前明确标为未验证。

**Tech Stack:** Go `net/http`, `go:embed`, `github.com/coder/websocket`; 原生 HTML/CSS/JavaScript、Screen Capture API、WebRTC；Node.js built-in test runner；测试专用 Playwright Core 驱动已安装桌面 Chrome 做合成媒体回环，不进入运行时 EXE。

**Spec:** `docs/superpowers/specs/2026-11-01-lan-screen-sharing-design.md`

## Global Constraints

- 所有源码、文档、测试和最终程序都位于 `D:\个人项目\局域网屏幕共享`；最终程序为 `dist\局域网屏幕共享.exe`。不另建 worktree。
- Go 工具链只下载官方 Windows zip 到项目外任务专用 cache，以绝对路径调用，不改全局 PATH、不做系统安装；Node.js 24 可作辅助。
- 目标为 Windows 桌面 Chrome/Edge；首发前验证目标浏览器组合，不把当前未测组合标成已支持。
- 房间固定 1 主播、最多 2 观众；默认无公网 STUN/TURN，局域网 P2P 失败时清晰报告，不宣称跨网可用。
- `restrictOwnAudio` 必须运行时检测并单独显示实机验证状态；不支持/未应用时不得静默启用“系统音频 + 内置语音”，提供“画面 + 语音（无游戏声音）”模式。
- 对话音频、屏幕系统音频和各成员麦克风独立映射；停止屏幕分享不停止语音；拒绝麦克风仍可观看/听语音。
- 不实现账号、文字聊天、录制、远控、SFU、云媒体转发、任意代理或互联网跨网连接。
- 不宣称 1080p60 性能已通过；必须区分合成/自动化结果与至少三台设备的真实游戏、声音隔离和人耳确认。
- 不删除或覆盖现存文件；当前工作目录没有 Git，Task 1 先在本目录初始化并提交设计/计划基线。

## Review Focus

1. 局域网/loopback 身份边界：伪造 Host/Origin、无控制凭证、观众码冒充 host、跨房间或非成员路由必须被拒绝（Task 1 的 handler/integration tests）。
2. 观众桥接输入：回环、公网、非 IPv4 私网、非法端口、非固定路径和过大消息必须被拒绝且不能形成代理（Task 1 tests）。
3. 麦克风拒绝或系统音频缺失：仍能观看/听语音，状态准确且不能把空音轨或 `getSettings()` 当人工回灌验证（Task 2 + Task 4）。
4. 同时加入、第三观众、断线与重连：席位不超 2，不产生重复 peer 或幽灵成员，离房清理 ICE/媒体（Task 1 + Task 4）。
5. 浏览器/游戏捕获差异：窗口误选、整屏音频无 track、自动播放阻止、ICE 失败和帧率回退要在 UI 如实显示，不冒称支持/性能通过（Task 2 + Task 4）。

---

## 固定协议契约（Task 1 后端与 Task 2 浏览器共同遵守）

### 公共 envelope

WebSocket JSON 使用 `{ "v": 1, "type": string, "requestId"?: string, "roomId"?: string, "peerId"?: string, "payload"?: object }`。所有请求带唯一 `requestId`，服务端响应保留该 ID。服务端永远从认证连接推导发送者 `peerId`，忽略客户端自报身份。请求失败返回 `{v:1,type:"error",requestId, payload:{code,message,retryable}}`；协议版本不符、未知消息、非法字段、超过 256 KiB 的 JSON 消息关闭连接或拒绝请求并记日志，不回显凭证。

### 端点与控制

- Task 1 contract refinement: `role=host` bootstrap also returns `lanIPv4` and the bound `signalPort` when a selected private IPv4 signaling listener is active. An unbound ephemeral port is omitted. These fields and `hostControlToken` are only returned after loopback plus same-origin browser validation.
- Local `/ws/v1` authenticates on its first frame with `auth.hello {role,hostToken?}`. A host must send the token obtained from `GET /api/v1/bootstrap?role=host`; a viewer sends only `role:"viewer"` and the server rejects a viewer frame carrying `hostToken`. The token is not accepted in a query string or on `/signal/v1`. The connection must have an actual loopback TCP `RemoteAddr` and matching loopback `Host`/`Origin` host and port.

- 本地页面 `GET /`、初始化 `GET /api/v1/bootstrap`、本机页面 WebSocket `GET /ws/v1` 均由当前机器服务提供；页面仅连接同源 localhost。
- bootstrap 返回 `{serviceId, localWsPath:"/ws/v1", roleOptions:["host","viewer"], hostControlToken?}`。主机控制 token 只在 loopback 请求中返回且仅在内存使用；服务校验 TCP `RemoteAddr` 为 loopback，并校验 token。Host/Origin 仅作附加防护。Viewer 页面不拿、也不发送该 token。
- 主播 LAN WebSocket 固定为 `ws://<host-private-ip>:<port>/signal/v1`；只接纳 room join、固定 signaling envelope、leave 和 heartbeat；不提供 HTTP proxy、任意 URL 或文件接口。Viewer Go 服务而非浏览器连接该地址。
- 本地浏览器到本机服务消息：`host.createRoom {}`、`host.endRoom {}`、`viewer.join {hostIPv4,hostPort,roomCode,resumeToken?}`、`viewer.leave {}`、`rtc.description {toPeerId,description,tracks:[{mid,role}]}`、`rtc.candidate {toPeerId,candidate}`、`media.state {screenSharing,hasScreenVideo,hasSystemAudio,isolationStatus}`、`heartbeat {}`。`host.endRoom` 和 `viewer.leave` 的 `roomId` 只放在 envelope 顶层，payload 是空对象 `{}`，不在 payload 重复。`resumeToken` 只在同一观众席位的 20 秒重连窗口使用，重连成功后服务旋转并返回新 token。
- 服务事件：`room.created {roomId,hostPeerId,roomCode,expiresAt}`、`room.joined {roomId,peerId,resumeToken,members:[{peerId,role,state}]}`、`room.state {members,screenSharing}`、`peer.joined {peerId,role}`、`peer.left {peerId,reason}`、`peer.state {peerId,state}`、`rtc.description {fromPeerId,description,tracks:[{mid,role}]}`、`rtc.candidate {fromPeerId,candidate}`、`room.ended {reason}`、`error`。
- Viewer Go → Host Go 加入消息携带 `roomCode` 及仅用于同一席位重连的 `resumeToken?`。成功后 host 分配不可预测 `peerId`，绑定连接与房间；信令只允许当前房间已加入 peer 发给同房成员。host 服务转发给目标成员本地 WS，viewer Go 再转给其本地 WS。房间码仅是观众 join 权限，永不授予 host 控制。
- ICE candidate 为浏览器 `RTCIceCandidateInit` JSON；SDP 为 `RTCSessionDescriptionInit` JSON。信令包带服务推导的 `fromPeerId`，target 为 `toPeerId`。SDP 的 `tracks` sidecar 只映射 `mid -> role`，来源成员由认证的 `fromPeerId` 决定；不依赖随机 `MediaStream.id`。
- `role` 固定枚举 `screenVideo | systemAudio | microphone`。Host-viewer peer connection 有 host→viewer 的 screenVideo、systemAudio transceiver 和一条双向 microphone transceiver；viewer-viewer 只有一条双向 microphone transceiver。每条 peer connection 的 voice sender 即本端 peer 的 mic；接收 source 即连接对端 peer。没有麦克风时 sender track 为空，仍保留接收语音能力。
- Host-viewer 由 host 创建 offer；viewer-viewer 由字典序较小 `peerId` 一侧创建 offer。每对成员只存在一个 peer connection。停止屏幕分享对 screen transceiver `replaceTrack(null)`，不关闭 voice 或 peer connection；结束房间/离开则关闭所有轨道和连接。

### 错误码

至少实现：`AUTH_REQUIRED`, `HOST_ONLY`, `ROOM_NOT_FOUND`, `ROOM_EXPIRED`, `ROOM_FULL`, `INVALID_INVITE`, `INVALID_HOST_ADDRESS`, `INVALID_PORT`, `SIGNAL_TARGET_NOT_MEMBER`, `SIGNAL_CONNECTION_LOST`, `MESSAGE_TOO_LARGE`, `UNSUPPORTED_PROTOCOL`, `ICE_FAILED`, `MIC_PERMISSION_DENIED`, `CAPTURE_CANCELLED`, `DISPLAY_NOT_MONITOR`, `SYSTEM_AUDIO_UNSUPPORTED`, `SYSTEM_AUDIO_UNVERIFIED`, `PORT_IN_USE`, `SERVICE_START_FAILED`。`SIGNAL_CONNECTION_LOST` 表示本机到主播信令桥接意外断开，`retryable=true`；本机保留观众的 roomId/peerId/resumeToken，Task 2 可以直接用保存的 `resumeToken` 再发 `viewer.join`，成功后存储旋转后的 token。用户文案中文且不含 token、SDP 或完整 stack trace。

观众房间码失败加入须按主播 LAN WebSocket 收到的 socket `RemoteAddr` 来源地址限速：每来源 IP 滑动 60 秒内最多 5 次失败，第 6 次返回 `RATE_LIMITED` 且 `retryable=true`；成功加入不计失败，合法 resume token 不因已成功加入或失败房间码次数而被阻断。实现状态表需 TTL 清理并有总量上限。

---

## 文件地图

- `cmd/lan-screen-sharing/main.go`：启动、参数、浏览器打开、优雅退出。
- `internal/app/server.go`：listener、静态资源、bootstrap、loopback/LAN 路由装配。
- `internal/app/auth.go`：高熵 host token、实际 RemoteAddr loopback 验证、bootstrap 防护。
- `internal/room/manager.go`：room、peer、口令、席位、重连与清理状态机。
- `internal/signal/hub.go`：本机 WS、host LAN WS、固定 envelope 校验和房间内路由。
- `internal/protocol/messages.go`、`messages_test.go`：共同 JSON schema、枚举与验证。
- `internal/web/embed.go`、`internal/web/assets/*`：go:embed 与原生页面资源。
- `internal/web/assets/app.js`：角色选择、服务协议、房间 UI、连接状态及控件。
- `internal/web/assets/media.js`：采集、mesh peer connection、轨道映射、stats 与音频隔离流程。
- `internal/web/assets/styles.css`、`index.html`：轻量界面。
- `tests/e2e/*`：Playwright Core 由 Node `node:test` 驱动已安装 Chrome 的本地 synthetic WebRTC E2E，不调用真实显示器、麦克风或系统音频。
- `tests/js/*`：Node built-in `node:test` 对 UI 状态和轨道/统计映射的单元测试。
- `README.md`：中文使用、网络边界、手动音频验证和故障排查。
- `docs/superpowers/reports/2026-11-01-validation.md`：自动化结果、构建信息与待用户实机验证字段；不填造结果。
- `dist/局域网屏幕共享.exe`：最终构建产物，不与源码/文档目录混放；按约定留在 D 盘项目内。

## Task 1: Go 本地服务、房间生命周期与信令桥接

**Files:**
- Create: `go.mod`, `cmd/lan-screen-sharing/main.go`
- Create: `internal/app/server.go`, `internal/app/auth.go`
- Create: `internal/room/manager.go`, `internal/room/manager_test.go`
- Create: `internal/signal/hub.go`, `internal/signal/hub_test.go`
- Create: `internal/protocol/messages.go`, `internal/protocol/messages_test.go`
- Create: `internal/web/embed.go`, `internal/web/assets/index.html`, `internal/web/assets/app.js`, `internal/web/assets/media.js`, `internal/web/assets/styles.css`（初始占位页面）
- Modify/initialize: current project Git metadata only as noted in Step 1; do not move or delete files.

**Interfaces:**
- Produces the HTTP routes, WS envelope, room/signaling events and error codes in the fixed protocol above; Task 2 consumes those exact names and fields.
- `room.Manager.CreateHost() (RoomSnapshot, HostCredential, error)`; `Join(roomCode, resumeToken string) (PeerSession, RoomSnapshot, error)`; `Leave(roomID, peerID string)`; `End(roomID string)`; `Route(roomID, fromPeerID, toPeerID string, msg SignalMessage) error`; `ExpireDisconnected(roomID, peerID string)`.
- `signal.Hub` authenticates each client at connection establishment, derives `peerId` server-side, and publishes typed room events; it never forwards client-supplied identity or arbitrary network destinations.

- [ ] **Step 1: Establish the D-drive baseline before implementation.** Since the workspace currently has no Git repository, run `git init -b feat/lan-screen-sharing` in `D:\个人项目\局域网屏幕共享`; stage only the current approved spec, this plan, SDD ledger, and task briefs; create `docs: approve lan screen sharing design baseline`; record the resulting hash as `BASE` in the ledger. Expected: worktree clean and all project files remain on D:.
- [ ] **Step 2: Define protocol schema tests.** Add `TestEnvelopeRoundTrip`, `TestRejectUnknownRoleAndVersion`, `TestRejectOversizedAndMalformedSignal`, `TestTrackMapRequiresUniqueMID` in `internal/protocol/messages_test.go`; assert exact JSON names, enums, max 256 KiB and errors listed above. Run `go test ./internal/protocol`; expected: FAIL before definitions.
- [ ] **Step 3: Implement typed protocol in `internal/protocol/messages.go`.** Define envelope, request payloads, response/event payloads, role/isolation enums and strict decoder with 256 KiB cap; run protocol tests and expect PASS.
- [ ] **Step 4: Implement `room.Manager` state machine.** In-memory rooms use 8-character ambiguity-free random room codes, one host + at most 2 viewers, one stable peer ID per membership, per-viewer resume token, 20-second reconnect reservation, room end invalidates all credentials. Implement the signatures above and tests `TestRoomCapacityAndThirdViewerRejected`, `TestReconnectKeepsPeerIDAndReclaimsSeat`, `TestLeaveAndEndInvalidateCredentials`, `TestExpiredRoomCodeRejected`; run `go test ./internal/room` and expect PASS.
- [ ] **Step 5: Implement local app routes and role-scoped auth.** Serve embedded page, `/api/v1/bootstrap`, `/ws/v1`; host create/end requires high-entropy in-memory host token plus actual TCP remote loopback; viewer joins cannot invoke host controls. Implement LAN bind to loopback plus explicitly selected private IPv4 only, `/signal/v1` fixed path, fail with `INVALID_HOST_ADDRESS`/`PORT_IN_USE` instead of all-interface fallback. Tests: `TestBootstrapOnlyReturnsHostTokenOnLoopback`, `TestHostControlRequiresTokenAndLoopback`, `TestViewerCodeCannotEndRoom`, `TestLanListenerBindsChosenPrivateIPv4Only`; run `go test ./internal/app` and expect PASS.
- [ ] **Step 6: Implement fixed signal hub and native viewer bridge.** Viewer Go connects only to validated private IPv4 + valid port + fixed `/signal/v1`, joins with room code, and forwards only protocol messages. Host routes SDP/candidates only to room members; `fromPeerId` is derived from socket; payload limits apply. Tests `TestRejectPublicLoopbackAndInvalidHostTarget`, `TestRejectArbitraryPathAndOversizedFrame`, `TestRoomOnlySignalRouting`, `TestViewerToViewerSignalViaHost`, `TestDisconnectedPeerCannotSignal`; run `go test ./internal/signal` and expect PASS.
- [ ] **Step 7: Embed a temporary role page and run service integration checks.** Verify `GET /` and bootstrap load, same-origin WS hello/create/join, host and viewer roles are isolated, third viewer gets `ROOM_FULL`, leave/end clean members, build starts without writing outside the project except Go toolchain cache. Run `go test ./...`; expected: PASS, no test opens media devices.

## Task 2: Browser room UI、P2P mesh 与媒体生命周期

**Files:**
- Modify: `internal/web/assets/index.html`, `internal/web/assets/app.js`, `internal/web/assets/media.js`, `internal/web/assets/styles.css`
- Create: `tests/js/room-state.test.js`, `tests/js/media-map.test.js`

**Interfaces:**
- Consumes Task 1 `/api/v1/bootstrap`, `/ws/v1`, fixed envelopes/events/errors and member roles.
- `RoomClient.connect({role, hostControlToken?}) -> Promise<void>`; `createRoom()`, `joinRoom({hostIPv4,hostPort,roomCode})`, `leaveRoom()`, `endRoom()` return server-confirmed snapshots.
- `MeshMedia.addPeer(peerId, role)`, `setScreenStream(stream|null)`, `setMicrophoneTrack(track|null)`, `setAudioIsolationState(state)`, `closePeer(peerId)`, `closeAll()`, `getStatsSnapshot()`. `MeshMedia` only signals through `RoomClient`; it never opens signaling network sockets itself.
- Track metadata uses `role` enum and `mid` sidecar from fixed contract; remote mic owner is the authenticated `fromPeerId` attached to the signaling channel.

- [ ] **Step 1: Write pure UI state and mapping tests.** Add tests `hostCanStopScreenWithoutEndingVoice`, `viewerCanJoinWithoutMicrophone`, `screenAudioAndMicRemainSeparate`, `displayModeRequiresMonitor`, `statsShowActualResolutionFpsAndBitrate`, `isolationNeverAutoPromotesFromSettings`; assert exact states/text and no fake “verified” state from `getSettings()` alone. Run `node --test tests/js/*.test.js`; expected: FAIL before implementation.
- [ ] **Step 2: Implement `RoomClient` in `app.js`.** Connect only to `bootstrap.localWsPath`; implement host/viewer flows, request IDs, errors, room state, reconnect status and three-seat display. Host control commands require bootstrap token; viewer UI never sends it. `getUserMedia` permission denial leaves viewer joined in receive-only microphone state and shows `MIC_PERMISSION_DENIED` guidance.
- [ ] **Step 3: Implement fixed transceivers in `media.js`.** For each host-viewer pair create screen video, system audio and bidirectional microphone transceivers; for viewer-viewer create only bidirectional microphone. Use deterministic lower-peerId offerer for viewer-viewer. Keep capture track and each member mic track separate; attach role/MID metadata with every SDP; route received microphone by `fromPeerId` and system audio separately.
- [ ] **Step 4: Implement screen selection and lifecycle.** On user button call `getDisplayMedia()`; pass monitor preference only as hint and inspect returned `displaySurface`; cancel/choose window/tab reports state and offers reselect. Request `systemAudio:"include"` and `restrictOwnAudio:true`; preview muted. Stopping share calls `replaceTrack(null)` for video/audio and retains voice PCs. Missing audio track shows “未捕获屏幕音频” without implying game sound.
- [ ] **Step 5: Implement system-audio isolation states and manual check.** States are `未验证`, `浏览器不支持`, `约束未应用`, `浏览器报告约束已应用·实机未验证`, `本房间用户手工确认`, `本房间用户手工未通过`. Feature detection and `getSettings()` can advance only to browser-reported state, never to user-confirmed. If unsupported/not-applied, do not start system audio plus built-in voice; offer explicit “画面 + 语音（无游戏声音）”. If applied but unverified, only start the combined mode through a clearly labeled manual test action. Provide three-person checklist: each remote participant speaks in turn, another confirms their voice does not recur on the screen/system stream, while game sound remains audible. Only explicit participant/host confirmation marks this room’s combination; never persist it as a supported-browser claim. On failure stop system audio and return to the limited mode.
- [ ] **Step 6: Implement receive controls and display metrics.** Separate screen preview muted; per-source gain/mute for each member mic; independent screen/system audio mute; autoplay recovery button. Show target quality separately from actual `getSettings()` and `getStats()` resolution/FPS/bitrate/dropped frames. Initial sender target values: 1080p60 8 Mbps, 720p60 5 Mbps, 720p30 2.5 Mbps; mark as provisional implementation starting points and tune only against recorded real-device data; never claim they guarantee performance. Use sender encoding controls where supported, and report unsupported capability without CSS-only pretending to reduce transmitted resolution.
- [ ] **Step 7: Run Node tests and browser static checks.** Run `node --test tests/js/*.test.js`; expected: PASS. Serve page from Go test server and inspect Chrome console/network: all UI WS requests stay on same-origin localhost and no external requests occur.

## Task 3: EXE 生命周期、构建与中文使用说明

**Files:**
- Modify: `cmd/lan-screen-sharing/main.go`, `internal/app/server.go`
- Create: `README.md`, `scripts/build.ps1`, `scripts/verify.ps1`
- Create output: `dist/局域网屏幕共享.exe`

**Interfaces:**
- CLI defaults to host mode on launch; browser UI can switch between host/viewer roles without restarting. Optional `--open-browser=false` supports automated tests; `--port` permits deterministic test ports.
- Build script uses the pinned Go toolchain path from external task cache, builds Windows amd64 single binary with embedded assets and writes only `dist/局域网屏幕共享.exe` under project.

- [ ] **Step 1: Add startup tests.** `TestPortConflictUsesBoundedRetry`, `TestNoBrowserOpenFlag`, `TestGracefulShutdownClosesListenersAndRooms`, `TestBrowserOpenUsesLocalhostOnly`; run `go test ./cmd/... ./internal/app`; expect PASS.
- [ ] **Step 2: Implement launcher lifecycle.** Pick loopback UI port, bind selected private IPv4 signaling listener when host room is created, retry only a bounded number of UI ports; print/copy a localhost URL if browser launch fails. On exit stop WS, listeners, rooms and tracks. Do not install service, elevate, modify firewall, or bind LAN UI to all interfaces.
- [ ] **Step 3: Add build and verify scripts.** `scripts/build.ps1` verifies external Go binary, builds GUI-capable Windows amd64 executable, embeds page, writes `dist/局域网屏幕共享.exe`; `scripts/verify.ps1` runs Go tests, Node tests and build then checks output exists and PE architecture is amd64. Expected: script exits nonzero on any failed check.
- [ ] **Step 4: Write Chinese README.** Document double-click/start, host creation, screen picker (select full monitor), host IP/port + room code sharing, viewer double-click/join, mic denial behavior, leaving/stop semantics, firewall/LAN caveats, audio-isolation manual test and limited mode, supported-browser status not yet certified, troubleshooting and how to report real-device metrics.
- [ ] **Step 5: Build and inspect the artifact.** Run `powershell -ExecutionPolicy Bypass -File scripts/verify.ps1`; expected: all automated tests PASS and `dist\局域网屏幕共享.exe` exists. Do not state executable size/performance benefits without measured evidence.

## Task 4: Synthetic browser mesh E2E、集成修复与验证报告

**Files:**
- Create: `tests/e2e/mesh.spec.js`, `tests/e2e/fixtures/synthetic-media.js`, test-only `package.json` and lockfile for pinned `playwright-core`
- Modify: `scripts/verify.ps1`, `README.md` only for issues found
- Create: `docs/superpowers/reports/2026-11-01-validation.md`

**Interfaces:**
- The E2E harness launches the built Go server and three local browser contexts against host + 2 viewer roles, using deterministic synthetic canvas video and oscillator audio injected through test-only media adapters. It does not invoke real display capture, real mic, or system-audio loopback.
- E2E tests use only public page controls and WS protocol. No test-only production route or auth bypass is added.

- [ ] **Step 1: Add failing 3-peer synthetic E2E cases.** Test `hostPlusTwoViewersExchangeSyntheticTracks`, `thirdViewerIsRejected`, `viewerCanJoinWithMicDenied`, `screenStopPreservesVoice`, `viewerViewerVoiceConnects`, `leaveAndReconnectReclaimsSeat`, `isolationSettingsDoNotMarkRealValidation`, `qualityStatsAreActualNotCSS`. Assertions check received track roles/source peers, seat count, state, and visible errors. Run `npm ci; node --test tests/e2e/mesh.spec.js`; expected: behavior cases fail before complete integration.
- [ ] **Step 2: Wire stable synthetic test adapter.** Inject canvas `captureStream(30)` and WebAudio oscillator stream only from E2E harness. Verify host and two viewers establish all three peer pairs through local signaling and direct browser WebRTC; all signaling stays in LAN/local WS without external network requests.
- [ ] **Step 3: Run and fix the complete automated suite.** Run `go test ./...`, `node --test tests/js/*.test.js`, `node --test tests/e2e/mesh.spec.js`, then `scripts/verify.ps1`; expected: all checks PASS. Fix interface mismatches in their owning task files; do not relax role, seat, or track assertions to make tests pass.
- [ ] **Step 4: Produce honest validation report.** Record commit hash, tool/browser versions, automated outputs, artifact path, synthetic test limitations, and real-device checklist fields. Mark system-audio loopback, actual game capture, microphone quality, real three-device 10-minute run, FPS/latency as “待用户实机验收”; do not fabricate or infer pass from synthetic media, `getSettings()`, or headset use.
- [ ] **Step 5: Perform final readback.** Confirm README matches final UI and protocol; confirm no external services are contacted; confirm `dist\局域网屏幕共享.exe` is inside D: project; list unsupported/unverified conditions in the report. Expected: deliverable is reproducible and no “1080p60 passed” claim appears absent real data.

---

## Plan Self-Review

- **Spec coverage:** full-monitor capture and game switching, screen and system audio, built-in 3-person mesh voice, independent microphone/system tracks and controls, no-mic viewer, host auth vs viewer room code, two-seat cap/expiry/reconnect, LAN-only signaling bridge, localhost pages, WebRTC P2P, `restrictOwnAudio` detection/manual validation/fallback, quality states, startup/exit/build/README, synthetic vs real-device checks, and WASAPI non-goal are assigned to Tasks 1–4.
- **Step scan:** each task begins with asserted failing tests or route lifecycle checks; implementations cite exact files, messages, values, and pass commands. No code is implemented by this plan-writing change.
- **Type/protocol consistency:** every UI, server, and E2E task consumes the shared envelope, endpoints, message types, error codes, `peerId`, MID/role mapping, and signaling route defined above. A signal source identity is always attached by Go from the authenticated socket.
- **Review Focus:** all five listed failure classes point to concrete unit/integration/E2E assertions. Browser synthetic E2E is explicitly not the real OS audio/game verification.
- **Proportion:** four independently reviewable tasks separate service contract, browser media/UI, packaging, and end-to-end validation. The protocol section is deliberately shared once, not copied into each task.
- **Git and SDD handoff:** no repository currently exists; Task 1 records the authorized in-place `git init -b feat/lan-screen-sharing` and approved design/plan baseline commit before source edits. Sequential Luna-only implementation/review remains the execution rule; no worktree or parallel agents.
