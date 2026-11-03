# 架构

每名成员在自己的 Windows 电脑运行单个 EXE。它在本机提供浏览器页面与控制接口；房主建立房间后提供局域网信令。浏览器通过 WebRTC 点对点传输视频、系统声音与语音，并通过同一组已认证 PeerConnection 的 DataChannel 传输文字。服务端不转发媒体或文字。局域网发现使用广播和组播；也支持房主地址、端口及房间码手动加入。

房间最多三名成员，房主维持房间；共享席位同一时间只属于一名已加入成员。停止屏幕共享会保留房间和语音，房主结束房间会通知成员。程序不提供跨网络中继，不改变系统防火墙。

- `cmd/lan-screen-sharing`：程序入口和启动参数。
- `internal/app`、`internal/signal`、`internal/room`、`internal/discovery`、`internal/protocol`：本机服务、信令、房间、发现和消息校验。
- `internal/web/assets`：嵌入 EXE 的正式浏览器界面及媒体逻辑。
- `room-experience.js`：入口/语音/观看布局及模态交互，复用媒体和控制节点。
- `room-text.js`、`room-text-ui.js`：房间文字的输入边界、通道、内存消息和可访问界面。
- `demos/frontend-lab`、`demos/experience-lab`：两轮独立模拟设计实验室，不与正式媒体服务连接。

本机页面控制凭证与普通加入信息分开。诊断和反馈不要公开房间码、本机控制凭证或私人画面。详见[验证与限制](verification.md)。
