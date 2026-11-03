# 第二轮体验原型 · 实现契约

目标：用同样的模拟真实状态检验三种组织轴，而不是再换三个皮肤。旧实验室保留，此目录独立。未经用户认可满意版本，不创建或上传 GitHub 仓库。

根代理拥有 index.html、experience.css、boot.js、helpers.js、app.js、build.mjs、tests.mjs 和 review-data.js。每位 Terra 只写分配的 layouts/<name>.js、layouts/<name>.css 与自己的实现评审文档。所有布局是 classic script，注册 window.LanDemo.layouts，返回 HTML 字符串，不注册事件/定时器/采集/网络。

三条内部键为 portal=同伴通道，orbit=来源展开，edge=接力现场。各自实现 entry(s,h)、voice(s,h)、watch(s,h)，根元素保留 .portal-entry/.portal-voice/.portal-watch 等对应类，内部使用自己的 ch-/so-/re- 前缀避免冲突。三阶段可单独选择，风格独立。不要覆盖全局 body/button 或实验室壳。

沿用 ../frontend-lab/model.js 和 ui.js 的 s 与 h 基本接口，详细见 ../frontend-lab/CONTRACT.md。h.e/icon/button/header/notice/screen/controls/shareButton/audio/memberLabel 可用。root 增加 h.person(s,id,{compact:false})（返回可直接调该人的成员对象按钮）、h.personAudio(s,id)（对应成员语音与其实际共享声音）、h.people(s,{compact:false})（真实成员集合）。成员按钮 data-action="member" data-value="owner|friend|self"，会打开对应声源控制；本机对象显示麦克风与自身共享，不出现远端自我音量。h.screen 使用同一演示图并清楚标记模拟。

共享动作：share/stop-share/watch/voice/sound/settings/invite/leave/fullscreen/room-menu/mic/mute(value成员或system)/join(value房间ID)/create/manual/refresh/retry，及 member(value成员ID)。不要创造假队列/请求/未实现按钮。主播选voice会停止自己的共享并保留mic；观众选voice只是本机不看画面/系统声，且朋友开播不得强制恢复观看。

重点旅程：从分享者→分别调他的语音与游戏声→只聊语音→恢复观看；朋友停播→原处可自己分享→模拟选屏取消→房间和mic保留。必须同时体现他人在分享、自己在分享、没共享、无系统音轨、断线/权限拒绝/空房/满房。

布局使用公共 CSS 变量：--surface/--surface-raised/--surface-soft/--ink/--muted/--line/--accent/--on-accent/--good/--danger/--shadow/--radius/--font-ui/--font-display。四种外观由统一主题变量控制，结构可独立选择。单个标题不要超过必要大小；对象/当前活动直接可操作，不把所有内容切成等权卡片，不露无意义01编号、IP/peerId/编码统计或诊断主界面。不做假的说话波形、成功状态、延迟数值。

支持 1440×900、900px、390px，完整画面contain；控件不依赖hover，不用自己绘制图标，使用已有Phosphor。所有操作可键盘/触摸，button+有意义标签，focus-visible，reduced-motion下含义不丢。watch主控制不能落到巨大图片下方不可见处。布局动效让状态变化可理解，但根代理管理阶段转换。
