# 设计原型的生成素材

以下素材使用内置 Image Gen 工具，参考此前生成的界面图重新制作；透明区域保留原始 alpha。围桌桌沿已复制为 `internal/web/assets/table-arc.png` 接入正式语音房间，其余用于独立设计原型。图片中的演示游戏画面另有既存素材，不代表真实直播质量。

| 素材 | 仓库内文件 | 用途 |
| --- | --- | --- |
| 房间卡弧面 | `demos/frontend-lab/assets/room-arcs-v1.png` | 晴蓝风格的前两张门牌背景 |
| 围桌桌沿 | `demos/frontend-lab/assets/table-arc-v1.png` | 宽屏围桌的背景组织线 |
| 中央屏幕插画 | `demos/frontend-lab/assets/screen-illustration-v3.png` | 晴蓝围桌的大屏空状态视觉焦点；屏幕内没有播放符号 |

最终采用的提示词：

1. **房间卡弧面：** “Use case: ui-mockup. Asset type: a reusable decorative overlay for a desktop app's room card. Use the provided room-discovery design only as visual inspiration. Produce ONLY the translucent sweeping arc motif: two large, smooth, restrained icy-blue concentric curved bands entering from the lower right and extending beyond the canvas edges; their thin light edges and gentle blue translucency should feel like the reference card. Leave the left half and upper left fully transparent, with the motif light enough for dark UI text to remain legible. Wide horizontal composition. Transparent background. No text, no letters, no icons, no buttons, no cards, no borders, no watermark.”
2. **围桌桌沿：** “Use case: ui-mockup. Asset type: subtle decorative background overlay behind three participant seats in an app. From the provided reference, isolate the spare, thin warm-gray elliptical arc that visually groups the three seats around the center. Produce ONLY one clean, delicate continuous elliptical outline, wide horizontal proportions, extremely subtle neutral warm gray, on a genuinely transparent background. Keep the middle and entire exterior transparent. Smooth anti-aliased line, no shadow, no texture, no blue or colored artifacts. No text, people, logos, icons, cards, controls or other shapes.”
3. **中央屏幕插画：** “Use case: ui-mockup. Create an isolated small flat vector-like illustration for a friendly light desktop application empty state. A simple front-facing muted blue-gray computer monitor on a short stand; the monitor display is a completely blank, uniform pale blue rectangle, no play or other symbol. Above it three short blue accent strokes. Crisp, clean, quiet, low-contrast, similar to a friendly system illustration. Transparent background with real alpha right up to the outer silhouette of the illustration. NO black background, dark backdrop, glow, haze, halo, shadow, text, triangle, icons, interface panels, cards, or extra objects. Keep the entire monitor and its three accents centered with transparent margin.”

屏幕原稿带有播放三角，可能暗示可以播放；第二次编辑的透明背景有黑色残留，因而两者都没有用于最终原型。当前第三稿去除了播放符号和黑色背景，并已在实际浅色页面上复核。构建脚本将这三项素材及演示游戏图内嵌到单文件；单文件测试逐字节核对它们与源素材一致。
