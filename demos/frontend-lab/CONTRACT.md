# 可交互设计实验室 · 协作契约

用户授权：将已探索的思路都做成可交互 demo，Terra 互评，独立组合设计与风格。这里是独立、可丢弃的设计原型，不是正式产品改造。仅修改 demos/frontend-lab 内自己负责的文件；不提交、启动服务器/浏览器或修改生产资产、dist、根依赖。

## 组合模型

交互结构三条路线 portal（房间会展开）、orbit（三人一桌）、edge（只留画面）。每条均需提供 entry、voice、watch 三个阶段的可用布局，不能只有截图对应阶段。实验室可对三个阶段分别选择路线，且可与 cinema（深色影院）、lounge（纸白客厅）、precision（冷白精密）三种视觉风格任意组合。主代理另提供综合预设，不将风格绑定结构。

## 文件和注册

agent 仅写 layouts/<key>.js 和 layouts/<key>.css，以及 reviews/<key>-implementation.md。classic script，不用 import/fetch。注册：

    window.LanDemo.layouts.portal = {
      entry: function (s, h) { return '<section class="portal-entry">...</section>'; },
      voice: function (s, h) { return '<section class="portal-voice">...</section>'; },
      watch: function (s, h) { return '<section class="portal-watch">...</section>'; }
    };

每个方法返回 HTML 字符串。根入口统一事件代理。不要注册自身事件、定时器或维护自身状态。所有动作都用真实 button/input，有标签、disabled 状态和 focus-visible。CSS 只用 .portal- / .orbit- / .edge- 自己前缀，或自己根下的后代选择器，不覆盖 body/button 等全局。

## state（共享只读输入）

    {
      scene:'entry'|'room', roomName:'今晚一起玩', owner:false,
      view:'voice'|'watch', presenter:null|'owner'|'friend'|'self',
      mic:false, connection:'connected'|'reconnecting'|'disconnected',
      discovery:'ready'|'searching'|'empty'|'blocked',
      rooms:[{id:'game', name:'今晚一起玩', count:2, sharing:true, full:false}, ...],
      members:[{id:'owner',label:'房主',self:false},{id:'friend',label:'成员',self:false},{id:'self',label:'我',self:true}],
      volumes:{owner:0.8,friend:1,system:0.7}, muted:{owner:false,friend:false,system:false},
      systemShared:true, quality:'1080p60', cursor:false,
      layout:{entry:'portal',voice:'portal',watch:'portal'}, theme:'precision'
    }

图中所有声画、人员、网络均模拟；不调用真实采集/网络。正常加入无自动麦克风。任何成员可共享，但别人在共享时不能抢占。自己共享时可停止，停止保留 mic。只聊语音时本机不播放画面和游戏声音，可回观看；不能自动恢复用户主动选择的纯语音。系统声音隔离不确定不可硬阻断。

## helpers（由主代理实现）

- h.e(value)：HTML 转义。
- h.icon(name)：MIT Phosphor 原版图标（无手绘）。可用名：mic,mic-off,screen,fullscreen,speaker,speaker-off,settings,leave,arrow-right,arrow-left,plus,chevron-down,people,headphones,copy,check,close,refresh,warning,link,grid,eye,moon,sun,sliders。
- h.button(action,label,{icon,kind:'primary'|'quiet'|'danger',disabled,value,attrs}={})：button 公共类 .d-button；自定义布局可外包，不改 helper 全局样式。
- h.header(s,{back:false,compact:false}={})：产品品牌、房间名/人数、状态、离开/邀请/设置等必要动作。entry 时品牌+创建+手动加入。
- h.screen(s)：真正 img 的演示共享画面（.d-screen，内部 .d-screen-image；contain 完整画幅），带共享者和“演示画面”标签，以及断线覆盖状态。不要自己画游戏或使用静态稿作为整页背景。
- h.controls(s,{compact:false}={})：麦克风、合法共享操作、观看/只聊语音、声音、设置。
- h.shareButton(s)：空闲开始、自己停止、他人占用禁用的正确共享操作。
- h.audio(s)：各位远端语音及系统声音的本机静音/音量；本机音频不能显示成远端。
- h.memberLabel(s,id)：按当前 self/owner 映射标签。
- h.notice(s)：只在实际模拟异常时返回明确状态提示。

## 根入口支持的动作

button: data-action="join" data-value="<room.id>"；create,manual,refresh,mic,share,stop-share,watch,voice,sound,settings,leave,fullscreen,room-menu,invite,mute（value=owner/friend/system）,retry。DOM 事件统一处理，不要虚构动作名。输入音量用 input type=range min=0 max=1 step=.05 data-volume="owner/friend/system"，当前值和可读 output 标签。自己的 mic 用 mic 动作。

弹出层/模拟选屏由根入口负责。root 统一 fullscreen 和 focus 管理。不要把不可用控件伪装成已生效；已满房间禁用且文字解释；空房间列表应有创建/手动加入；共享结束显示新状态而非永久冻结帧。

## 视觉变量（样式与布局完全解耦）

所有色彩/材质使用 tokens：--surface,--surface-raised,--surface-soft,--ink,--muted,--line,--accent,--on-accent,--good,--danger,--shadow,--radius,--font-ui,--font-display。真实共享画面底色可 #080a0d，白色内容浮层文字必须有足够深的底，其他不要硬编码配色。布局、留白、布局动画属于结构；字体/颜色/材质/基本圆角属于风格。不可写 [data-theme=...] 改结构。

风格切换时保留房间/角色/视图/麦克风/音量状态；切结构也不重置场景。支持 1440×900，窄窗不挤出屏幕；prefers-reduced-motion 下全部可用。避免不必要的常驻成员栏、大口号和嵌套卡片。

## 参考

三个布局族的实现和交叉互评见 [reviews/](reviews/)。浏览器视觉与操作需要基于实际页面证据核对；离线 DOM 检查不能替代真实采集验收。
