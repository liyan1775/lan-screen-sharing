# 素材与第三方组件

- 生产程序使用 `github.com/coder/websocket v1.8.15` 和 Go 运行时/标准库。随包保留的[第三方许可原文](public-test/0.3.0/开源组件许可.txt)包含相应版权、许可和 Go PATENTS。
- 正式程序与前端设计实验室使用 `@phosphor-icons/core 2.1.1` 图标。正式程序的 MIT 许可原文在 [PHOSPHOR-LICENSE.txt](../internal/web/assets/PHOSPHOR-LICENSE.txt)，发行包许可说明也保留全文；实验室单文件内含对应许可。
- 实验室的 `game-scene.png` 是设计探索中由 AI 生成的虚构冒险游戏演示，非产品实机直播截图；其文件与原生成文件的 SHA-256 已核对一致。
- 正式语音房间的桌面弧线来自本项目设计探索的 AI 生成素材；控件、文字和媒体均为真实 HTML 界面，没有把概念图当作可用页面。素材生成记录见[生成说明](design-research/generated-ui-assets.md)。
- Node 的 `linkedom`、`playwright-core`、`axe-core` 是开发/测试依赖，不包含在生产 EXE 中；具体版本与许可见锁文件及各依赖的许可文件。

项目尚未指定整体开源许可证；上述第三方许可只适用于对应组件。
