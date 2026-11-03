# 0.4.0 实际浏览器截图与视觉差异

最终 Windows x64 EXE，1440×1000 CSS px，另检查 390×844 和 200% 文字。使用真实本机信令、原生 WebRTC 与明确的合成测试媒体；房间与消息是测试内容。本目录 30 张截图及 [evidence.json](evidence.json) 绑定同一个交付构建。

视觉参考沿用 [macOS 屏幕共享](https://www.macstories.net/stories/macos-sonoma-the-macstories-review/11/)、[Apple 系统设置](https://support.apple.com/guide/mac-help/find-system-settings-mchl8d10839d/mac)、[FaceTime](https://support.apple.com/en-au/guide/facetime/fctm35523/mac)及[信息](https://support.apple.com/zh-cn/guide/messages/icht8a28bb9a/mac)的实际应用截图。参考来自不同版本、任务与尺寸，不作像素级相似度评分。用户已暂定本轮视觉方案。

| 重要页面 | 本次实际截图 | 与参考仍存在的差异 |
| --- | --- | --- |
| 房间列表 | [浅色](02-entry-light.png)、[深色](01-entry-dark.png)、[有房间](15b-rooms-fixture-light.png) | 使用房间状态行和创建／加入操作，参考的原生屏幕共享采用侧栏及设备网格。 |
| 加入 | [单框粘贴](23-paste-invite-light.png)、[390px](24-paste-invite-390.png)、[无效输入](18-invalid-join.png) | 浏览器中的居中表单，备用字段按需展开；控件由 Windows 浏览器绘制，与系统设置的原生多栏窗口不同。 |
| 创建 | [创建表单](03-create.png) | 沿用表单任务分组与轻边界，保留本产品的房间名和局域网发现选项。 |
| 邀请 | [浅色](26-copy-invitation-light.png)、[深色](25-copy-invitation-dark.png)、[390px](27-copy-invitation-390.png) | 以一段完整邀请和复制为主，使用网页对话框，不具备原生窗口系统材质。 |
| 语音 | [三人成员列](04-voice-three.png)、[成员摘要](21-voice-members.png) | FaceTime 参考是视频通话；本产品显示成员、语音状态、单独音量和共享空状态。 |
| 设置 | [默认系统声音](06-settings.png)、[200%文字](14-settings-text-200.png) | 采用分组行及标签控件对齐；字体、下拉菜单、复选框和材质与原生系统设置不同。 |
| 观看与全屏 | [观看](08-watch.png)、[全屏](10-fullscreen.png)、[390px](11-watch-390.png) | 必要操作常驻，FaceTime 参考采用浮动控制；保留本产品的键盘、全屏与可发现性。 |
| 声音 | [声音面板](09-sound.png) | 网页对话框按成员及系统声音组织，保留独立音量，不等同 macOS 的原生面板。 |
| 文字 | [普通会话](05a-text-conversation.png)、[输入安全回归](05-text.png) | 信息参考为独立会话窗口，本产品为房间内面板，额外保留发送结果与隐私说明。 |
| 恢复 | [短暂断线恢复](23-local-recovered.png) | 保留当前房间并在工具栏显示恢复状态；这是本产品新增行为，没有宣称对应 Apple 原生流程。 |

视觉增量检查通过，未发现本次新增的视觉阻断。跨页面仍使用 Windows 系统回退字体及项目 Phosphor 图标，缺少原生 SF 字体、SF Symbols 和系统材质的完全一致表现。未在真实 Mac 上复验。

HIG 回归单独记录：21 个状态的 axe 自动违规为 0，14 条 incomplete 待人工判断；实际键盘焦点、深浅模式、窄窗、文字放大和核心流程测试通过。该结果不代表完整 HIG／WCAG 或真实音视频采集验收，详见[验证说明](../../verification.md)。
