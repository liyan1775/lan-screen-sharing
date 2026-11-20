# 素材与第三方组件

- 生产程序使用 `github.com/coder/websocket v1.8.15`、`github.com/pion/webrtc/v4 v4.2.26` 及其传输依赖和 Go 运行时/标准库。当前[第三方许可原文](third-party-notices.txt)包含实际运行依赖的版权、许可和 Go PATENTS，由 `scripts/write-third-party-notices.ps1` 从锁定的模块缓存生成。构建同时生成与 EXE 同名的 `.licenses.txt`；公开测试打包优先使用该构建旁的许可文件，保留旧版本说明作为旧构建的回退。
- 正式程序与前端设计实验室使用 `@phosphor-icons/core 2.1.1` 图标。正式程序的 MIT 许可原文在 [PHOSPHOR-LICENSE.txt](../internal/web/assets/PHOSPHOR-LICENSE.txt)，发行包许可说明也保留全文；实验室单文件内含对应许可。
- 实验室的 `game-scene.png` 是设计探索中由 AI 生成的虚构冒险游戏演示，非产品实机直播截图；其文件与原生成文件的 SHA-256 已核对一致。
- 正式语音房间的桌面弧线来自本项目设计探索的 AI 生成素材；控件、文字和媒体均为真实 HTML 界面，没有把概念图当作可用页面。素材生成记录见[生成说明](design-research/generated-ui-assets.md)。
- Node 的 `linkedom`、`playwright-core`、`axe-core` 是开发/测试依赖，不包含在生产 EXE 中；具体版本与许可见锁文件及各依赖的许可文件。

项目尚未指定整体开源许可证；上述第三方许可只适用于对应组件。

产品介绍页的截图和操作短片来自已发布的 0.5.0。录制用同一台 Windows 电脑上的三个程序实例和原生 WebRTC 连接。画面采用项目自制的骑行路线演示稿，声音来自合成输入。短片为静音，并带简体中文字幕。录制使用隔离浏览器资料，邀请字段做了遮蔽。复录方式见[验收说明](verification.md#宣传页与首次上手-2026-11-20)。网页使用系统字体。旧版介绍页的蓝色丝带素材 `website/assets/hero-flow.png` 来自项目早期的 Sites 介绍站。
