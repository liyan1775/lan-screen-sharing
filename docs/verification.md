# 验证与限制

2026-11-03 的 0.3.0 候选已完成真实前端接入和独立 Apple HIG 设计审查。独立审查者另行启动程序，以实际服务资源、纯键盘操作、无障碍树、截图和偏好适配为证据，确认本 Windows 浏览器产品全部 37 项适用设计要求通过，未关闭设计阻断为 0。完整范围和逐项证据见[独立审查报告](design-research/apple-hig-independent-review.md)。这不是 Apple 官方认证。

## 已执行的检查

| 检查 | 当前结果 | 验证范围 |
| --- | --- | --- |
| `go test ./... -count=1` | 通过 | 本机服务、消息校验、房间/共享生命周期、发现、安全边界及真实 WebSocket 测试 |
| `npm test` | 133 项通过 | 媒体生命周期、播放器连续性、房间控件、文字边界与测试夹具逻辑 |
| `node --test tests/e2e/frontend-hig.spec.js` | 通过 | 三个真实本机程序、隔离 Edge、原生 WebRTC 和合成媒体；22 张实际截图、16 个状态 axe 检查、AX 树及焦点行为 |
| `node --test tests/e2e/mesh.spec.js` | 8 项通过 | 三方原生传输、满员拒绝、拒绝麦克风、停播保留语音、观众间双向 RTP、断开/重新加入、隔离状态与真实统计 |
| `npm run lab:build` / `npm run lab:test` | 源码和单文件各 23 项通过 | 第一轮 81 种组合的离线 DOM/状态检查 |
| `npm run experience:build` / `npm run experience:test` | 源码和单文件各 38 项通过 | 两轮方案组合的离线 DOM/状态检查，不采集媒体 |

浏览器检查覆盖入口、创建与手动加入、成员摘要、文字互发、日常设置与折叠诊断、确认、观看与全屏、音量焦点保留、失效加入及断开恢复。还检查了系统浅深外观、390px 窄屏、200% 文字、减少动态效果、增加对比度与强制颜色。多房间/满员/加入中的发现列表使用明确标记的本地响应夹具，没有把它当作局域网发现质量测试。

最终[运行证据](design-research/apple-hig-qa/final/evidence.json)的 `completed` 为 `true`，页面错误和外部资源请求均为 0。11 个实际服务资源与源码逐一核对哈希；通过版本 EXE SHA256 为 `603834fa1d18520c83f881f1553b51832f2bf2f677a9cb155bce69d3cc6bd593`。发行 EXE 必须与该候选字节一致。

axe violations 为 0。剩余对比度和实时视频字幕 incomplete 已按实际背景、叠层和共享情境人工处置；不能把自动化零违规等同于所有媒体内容或所有辅助技术取得认证。

## 真实设备范围

本轮没有采集真实屏幕或麦克风，也没有进行三台实体设备、系统声音隔离听感、后台游戏帧率、不同分辨率鼠标捕获或真实 VoiceOver/Narrator 验证。系统声音即使隔离未确认也可能发送；真实设备的音质、回声、游戏兼容性和帧率仍需公开测试反馈。任意共享内容没有自动字幕或自动转写。

## 复现

```powershell
npm ci
npm test
npm run lab:build
npm run lab:test
go test ./... -count=1
powershell -NoProfile -File scripts/build.ps1 -BuildVersion 0.3.0
```

浏览器验收额外运行：

```powershell
$env:LANSW_EXE = (Resolve-Path './dist/局域网屏幕共享-0.3.0.exe').Path
$env:LANSW_BROWSER_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node --test tests/e2e/frontend-hig.spec.js
node --test tests/e2e/mesh.spec.js
```

浏览器测试使用隔离上下文和测试自有服务，捕获 API 由 canvas/WebAudio 合成轨道替代，没有绑定日常浏览器资料。CI 配置执行自动测试、两轮实验室打包、Windows 构建及合成媒体浏览器检查。
