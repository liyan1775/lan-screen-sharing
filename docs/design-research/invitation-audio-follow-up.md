# 默认系统声音与单段邀请加入

日期：2026-11-03。用户已确认当前视觉方案“这一版我比较满意，暂定这一版”。此次沿用该方案，解决默认共享系统声音及手动加入需填写三项的问题。

本文保留首次增量预览的历史证据。这些改动随后与刷新／断线恢复一起集成到 [0.4.0](../releases/v0.4.0.md)，当前发布构建与检查结果见[验证说明](../verification.md)。

## 行为与使用方法

- 新页面默认选择“画面 + 屏幕系统音频 + 语音”。退出房间、重新加入时也恢复此默认值；房内主动选择无系统声音或停止系统声音仍然有效。默认设置不会主动启动捕获，只有点击共享按钮才请求浏览器授权。
- 浏览器选择窗口仍需选整个显示器并允许共享系统音频。浏览器没有返回音轨时，画面不会直接静默发布，继续保留“无游戏声音继续”或取消重选的明确选择。
- 房间内“邀请朋友 → 复制邀请信息”复制一段完整内容，例如 `192.168.1.20:45678  房间码 ABCD2345`。朋友运行自己的程序，在“手动加入”的一个输入框中整段粘贴，点击加入或按 Enter 即可。
- 兼容旧版本复制的完整邀请格式，也接受 `192.168.1.20:45678/ABCD2345`。原来的三个字段收进“分别填写地址、端口和房间码”；附近房间的一键加入继续保留。
- 邀请会校验私网 IPv4、端口及房间码。编辑备用字段时清除原先粘贴值，避免改了字段却仍使用旧邀请；有效邀请会清除旧错误状态。自动复制失败时选中完整邀请，提示按 Ctrl+C。

## 功能与 HIG 回归结果

- `npm test`：138 项通过。新增邀请解析、无效邀请拦截、默认捕获约束、旧错误清除及邀请窗口的折叠详情焦点回归。
- `tests/e2e/mesh.spec.js`：8 项通过，覆盖真实三实例信令与原生 WebRTC，使用合成视频和音频。原来的分别填写方式、房间满员、麦克风拒绝、停止共享保留语音及断线后重新加入均通过。
- 交付 EXE 的 `tests/e2e/frontend-hig.spec.js`：通过。覆盖单框粘贴与 Enter 加入、默认系统声音、原有房间／文字／媒体操作、全屏、深浅外观、390px、200% 文字、对话框焦点和断线恢复；校验了 12 个嵌入资源与当前源码的哈希一致。
- axe 对 21 个状态报告 0 项自动识别的 violation；12 条 `incomplete` 仍需人工判断。此结果只代表已覆盖的检查，完整 HIG 与 WCAG 合规不据此直接判定通过。
- 额外在两个独立程序实例的可见浏览器中操作“复制 → 整段粘贴 → Enter”，确认进入同一房间且显示两名成员。该验证房间已结束，临时加入端已关闭。
- 本次发现并修复了新折叠详情中的隐藏字段干扰键盘焦点循环的问题，已验证展开与收起两种状态。

未进行真实系统声音听感、真实麦克风、三台物理设备及读屏软件复验。既有 Go 逻辑未改动；本次完成 Go EXE 构建，未重复完整 Go 测试，视觉基线的 Go 全包结果见原报告。

## 视觉设计增量验收结果

沿用[已确认的 macOS 视觉基线及实际 Apple 应用参考](macos-desktop-visual-acceptance.md)。本轮不重新选择视觉方向，检查新增内容是否保持其排版、控件、层级和深浅外观；此结论与上面的 HIG 回归分开。

| 重要页面 | 浏览器截图 | 与基线的差异及结果 |
| --- | --- | --- |
| 手动加入 | [浅色](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/23-paste-invite-light.png)、[深色](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/22-paste-invite-dark.png)、[390px](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/24-paste-invite-390.png) | 相比[原三项表单](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/after/02-join-light-v5.png)，主路径减少为一个输入框，备用字段默认收起；沿用原表单宽度、标题和蓝色主操作。截图中预填值为先前失败的测试发现邀请；[可见浏览器截图](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/cua-single-invitation.png) 为新页面空输入状态。无所测横向溢出。 |
| 邀请朋友 | [浅色](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/26-copy-invitation-light.png)、[深色](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/25-copy-invitation-dark.png)、[390px](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/27-copy-invitation-390.png) | 完整邀请与复制成为主要内容，三项连接信息改为按需展开。保留已确认的网页弹窗、轻边界和中性表面；说明文字在窄窗换行，主按钮完整可见。 |
| 设置 | [默认声音模式](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/06-settings.png) | 相比[原设置](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/after/05-settings-dark-v5.png)，更改默认选项与声音说明，继续使用原有分组行、标签对齐与控件。 |

增量视觉检查通过，未发现本轮新增的视觉阻断。仍存在的平台差异沿用原报告：Windows 字体与浏览器控件、项目图标、网页弹窗和 macOS 原生字体、符号、系统材质及窗口表现不同；未在真实 Mac 上重新目测。本轮没有把功能简化或自动化通过当成更接近原生 macOS 的新证明。

## 交付与证据

- 本地预览 EXE：`D:/个人项目/局域网屏幕共享/dist/局域网屏幕共享-视觉预览.exe`。
- SHA-256：`6c4d699c205708ffd3eae8276d6d6374f002ae581914bd79965cbfe6c08a794a`。
- 最终交付证据：[evidence.json](C:/Users/35442/.codex/visualizations/2026/11/03/01a1a040-b127-7d91-bd19-4f2582252f97/macos-visual-review/invite-audio-update/hig-delivery-final/evidence.json) 与同目录 30 张浏览器截图。媒体截图使用合成媒体。
- 公开发布的 0.3.0 包没有更新，此次改动仅在当前源码与上述本地预览构建中。
