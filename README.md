<h1 align="center">LAN / 分享</h1>

<p align="center">同一局域网，一起看同一屏。最多三人共享屏幕、开麦和聊天，无需账号或云端中转。</p>

<p align="center">
  <a href="https://liyan1775.github.io/lan-screen-sharing/">在线宣传页</a> ·
  <a href="https://github.com/liyan1775/lan-screen-sharing/releases/download/v1.1.0/lan-screen-sharing-1.1.0-windows-x64.zip"><strong>下载 v1.1.0 Windows 版</strong></a> ·
  <a href="docs/releases/v1.1.0.md">版本说明</a> ·
  <a href="LICENSE">Apache-2.0 开源</a>
</p>

<p align="center">
  <img src="website/assets/screen.png" width="59%" alt="v1.1.0 观看共享屏幕，左上角有实收画质，右上角有看屏工具，下方是一行玻璃控制坞">
  <img src="website/assets/room.png" width="39%" alt="v1.1.0 三人语音房间，展示各自的昵称和头像颜色">
</p>

## 为什么好用

- **零云端，局域网与校园网直连。** 无需登录。支持多路径局域网发现，也支持保存常用好友 IP 做单播直连探测，校园网屏蔽广播同样秒找房间。
- **整屏打游戏，单标签页看视频。** 支持共享整块显示器，也支持直接共享单个浏览器标签页（看 B 站/在线视频自带纯标签页声音、不暴露桌面且帧率更稳）。
- **单次编码 + 清晰度优先。** 同一份编码画面由分享者本机转发给两位观众，优先显卡硬编 H.264、默认锁定清晰度目标 1080p60 / 8 Mbps，实发分辨率变化一眼可见。
- **冰青瓷银双模式玻璃交互。** 同时提供亮白瓷器浅色与暗夜黛青深色界面，配单行玻璃控制坞、局部放大、画中画与原画 PNG 截屏。
- **自由麦、按键说话和本机试音。** 支持选麦、独立音量、飘屏小表情、房间文字链接与一键复制消息。
- **优先推荐真实局域网网卡。** 昵称、头像颜色、麦克风、网卡与好友探测 IP 均可跨重启保留。

## 三步开始

1. **大家运行同一版。** 完整解压 Windows x64 ZIP。先打开 `先看这里.html`，再双击 `局域网屏幕共享.exe`，用桌面版 Edge 或 Chrome 打开本机页面。
2. **一人建房，朋友加入。** 电脑须在能互相访问的私有 IPv4 局域网。朋友可以从“附近的房间”加入；校园网屏蔽广播时，手动加入一次即可自动记住好友 IP，下次自动刷出。
3. **选整屏或单标签页开始共享。** 点“共享我的屏幕”，打游戏选整块显示器、看网页视频选单个浏览器标签页，按需授权声音和麦克风。停止分享后，房间仍可语音和聊天。

## 开发与构建

在 Windows PowerShell 中执行。Go 版本以 `go.mod` 为准，CI 使用 Node.js 24。构建会同时生成第三方许可清单。

```powershell
npm ci
go test ./... -count=1
npm test
$releaseExe = 'dist/release-1.1.0/局域网屏幕共享-1.1.0.exe'
.\scripts\build.ps1 -OutputPath $releaseExe
.\scripts\package-release.ps1 -ExePath $releaseExe
```

| 文档 | 内容 |
| --- | --- |
| [v1.1.0 版本说明](docs/releases/v1.1.0.md) | 正式版新功能、修复与验证范围 |
| [v1.0.0 版本说明](docs/releases/v1.0.0.md) | 首个正式版归档说明 |
| [版本与发行规范](docs/versioning.md) | SemVer、同版建议、Tag、Release 与 Pages 发布 |
| [系统架构](docs/architecture.md) | 局域网发现、房间信令和媒体通路 |
| [验证与限制](docs/verification.md) | 本机回归、复现方式与实测边界 |

## 开源许可

Copyright 2026 liyan1775。项目采用 Apache-2.0。再分发时按协议保留适用的署名声明。Windows 完整包附带项目许可、署名与第三方组件许可。 [LICENSE](LICENSE) · [NOTICE](NOTICE) · [第三方许可](docs/third-party-notices.txt)
