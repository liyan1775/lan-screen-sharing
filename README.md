<h1 align="center">LAN / 分享</h1>

<p align="center">同一局域网，一起看同一屏。最多三人共享屏幕、开麦和聊天，无需账号或云端中转。</p>

<p align="center">
  <a href="https://liyan1775.github.io/lan-screen-sharing/">在线宣传页</a> ·
  <a href="https://github.com/liyan1775/lan-screen-sharing/releases/download/v1.3.0/lan-screen-sharing-1.3.0-windows-x64.zip"><strong>下载 v1.3.0 Windows 版</strong></a> ·
  <a href="docs/releases/v1.3.0.md">版本说明</a> ·
  <a href="LICENSE">Apache-2.0 开源</a>
</p>

<p align="center">
  <img src="website/assets/screen.png" width="59%" alt="观看共享屏幕，左上角有实收画质，右上角有看屏工具，下方是一行玻璃控制坞">
  <img src="website/assets/room.png" width="39%" alt="三人语音房间，展示各自的昵称和头像颜色">
</p>

## 为什么好用

- **零云端，局域网与校园网直连。** 无需登录。支持多路径局域网自动发现，也可在设置里添加指定查找地址，即使网络屏蔽广播也能快速找到朋友房间。
- **整屏、应用窗口、浏览器标签页都能分享。** 选应用窗口即可开播，不分享应用声音。看网页视频可以选浏览器标签页并勾选分享标签页声音。
- **单次编码 + 清晰度优先。** 同一份编码画面由分享者本机转发给两位观众，优先显卡硬编 H.264 High 档位并支持自动兼容回退。默认目标为 1080p60，码率上限 25 Mbps，也可选 720p60（最高 8 Mbps），实际随画面和网络变化。
- **冰青瓷银双模式玻璃交互。** 同时提供亮白瓷器浅色与暗夜黛青深色界面，配单行玻璃控制坞、局部放大、画中画与原画 PNG 截屏。
- **自由麦、按键说话和本机试音。** 支持选麦、独立音量、飘屏小表情、房间文字链接与一键复制消息。
- **优先推荐真实局域网网卡。** 昵称、头像颜色、麦克风、网卡与指定查找的地址均可跨重启保留。

## 三步开始

1. **大家运行同一版。** 完整解压 Windows x64 ZIP。先打开 `先看这里.html`，再双击 `局域网屏幕共享.exe`，程序会优先通过 Edge 或 Chrome 打开独立应用窗口。
2. **一人建房，朋友加入。** 电脑须在能互相访问的私有 IPv4 局域网。朋友可以从“附近的房间”加入；自动发现不到时，手动加入一次即可自动记住该地址，下次自动显示房间。
3. **选择要共享的内容。** 点击“选择内容并开始共享”，选整屏、单个应用窗口或浏览器标签页，按需授权声音和麦克风。点击“停止共享”后，房间仍可语音和聊天。

## 开发与构建

在 Windows PowerShell 中执行。Go 版本以 `go.mod` 为准，CI 使用 Node.js 24。构建会同时生成第三方许可清单。

```powershell
npm ci
go test ./... -count=1
npm test
$releaseExe = 'dist/release-1.3.0/局域网屏幕共享-1.3.0.exe'
.\scripts\build.ps1 -OutputPath $releaseExe
.\scripts\package-release.ps1 -ExePath $releaseExe
```

| 文档 | 内容 |
| --- | --- |
| [v1.3.0 版本说明](docs/releases/v1.3.0.md) | 当前正式版改进与验证范围 |
| [v1.2.0 版本说明](docs/releases/v1.2.0.md) | 历史版本归档说明 |
| [v1.1.1 版本说明](docs/releases/v1.1.1.md) | 历史版本归档说明 |
| [v1.1.0 版本说明](docs/releases/v1.1.0.md) | 历史版本归档说明 |
| [v1.0.0 版本说明](docs/releases/v1.0.0.md) | 首个正式版归档说明 |
| [版本与发行规范](docs/versioning.md) | SemVer、同版建议、Tag、Release 与 Pages 发布 |
| [系统架构](docs/architecture.md) | 局域网发现、房间信令和媒体通路 |
| [验证与限制](docs/verification.md) | 本机回归、复现方式与实测边界 |

## 开源许可

Copyright 2026 liyan1775。项目采用 Apache-2.0。再分发时按协议保留适用的署名声明。Windows 完整包附带项目许可、署名与第三方组件许可。 [LICENSE](LICENSE) · [NOTICE](NOTICE) · [第三方许可](docs/third-party-notices.txt)
