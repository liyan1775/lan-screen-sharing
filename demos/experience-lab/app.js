(function () {
  'use strict';
  var D = window.LanDemo, s = D.model.initial(), h;
  var canvas = document.getElementById('product-canvas'), surface = document.getElementById('demo-surface'), layer = document.getElementById('overlay-layer');
  var overlay = null, overlayError = '', returnTarget = null, epoch = 0, toastTimer, scenarioName = 'nearby', previousPhase = 'entry', previousRoute = 'portal', transition = null, flipAnimation = null, paintRevision = 0, joiningRoom = '', returningRoom = '', returnToDiscovery = false;
  var drafts = { createName: '今晚一起玩', manualAddress: '192.168.1.20', manualPort: '45678', manualCode: 'DEMO2026' };
  function $(id) { return document.getElementById(id); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function announce(text) { $('lab-live').textContent = text; }
  function phase() { return s.scene === 'entry' ? 'entry' : s.view; }
  function rememberFocus(element) {
    var a = element || document.activeElement;
    if (!a || a === document.body || !a.getAttribute) return null;
    return { node: a, id: a.id, action: a.getAttribute('data-action'), value: a.getAttribute('data-value'), volume: a.getAttribute('data-volume'), world: a.getAttribute('data-world') };
  }
  function restoreFocus(target) {
    if (!target) return;
    var node = target.node && target.node.isConnected ? target.node : target.id ? $(target.id) : null;
    if (node && node.disabled) node = null;
    if(target.world&&(!node||node.disabled)){
      var nextWorld={stop:'start',start:'stop',drop:'restore',restore:'drop'}[target.world];
      node=nextWorld?Array.from(document.querySelectorAll('[data-world]')).find(function(b){return b.dataset.world===nextWorld&&!b.disabled&&b.closest('.lab-focus-tools')===target.node.closest('.lab-focus-tools');}):null;
      if(!node)node=canvas;
    }
    if (!node && target.action) node = Array.from(canvas.querySelectorAll('[data-action]')).find(function (b) { return b.getAttribute('data-action') === target.action && b.getAttribute('data-value') === target.value; });
    if (!node && target.volume) node = Array.from(canvas.querySelectorAll('[data-volume]')).find(function (i) { return i.getAttribute('data-volume') === target.volume; });
    if (node && node.disabled) node = null;
    if (!node && target.action === 'join' && s.busy === 'joining') node = $('portal-joining-status');
    if (!node && target.id === 'portal-joining-status' && s.scene === 'room') node = surface.querySelector('h1') || canvas;
    if (!node && target.action) {
      var nextAction={voice:'watch',watch:'voice','stop-share':'share','confirm-share':'stop-share'}[target.action];
      if(nextAction)node=Array.from(surface.querySelectorAll('[data-action]')).find(function(b){return b.dataset.action===nextAction&&!b.disabled;});
      if(!node){node=surface.querySelector('h1')||canvas;if(node!==canvas)node.setAttribute('tabindex','-1');}
    }
    if (node && !node.disabled && node.focus) { if (/^H[1-6]$/.test(node.tagName)) node.setAttribute('tabindex','-1'); node.focus({ preventScroll: true }); }
  }
  function setSelect(id, value) { var el = $(id); if (el) Array.from(el.options).forEach(function (o) { o.selected = o.value === value; }); }
  function presetKey() { var k = Object.keys(D.model.routeNames).find(function (x) { return s.layout.entry === x && s.layout.voice === x && s.layout.watch === x; }); return k || (s.layout.entry === 'portal' && s.layout.voice === 'orbit' && s.layout.watch === 'edge' ? 'mix' : 'custom'); }
  function renderLab() {
    ['entry','voice','watch'].forEach(function (p) {setSelect('layout-'+p,s.layout[p]);}); setSelect('theme-choice',s.theme); setSelect('scenario-choice',scenarioName);
    setSelect('focus-route',presetKey());
    document.querySelectorAll('[data-preset]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.preset === presetKey())); });
    document.querySelectorAll('[data-style]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.style === s.theme)); });
    document.querySelectorAll('[data-preview]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.preview === (phase()==='entry'?'nearby':phase()==='voice'?'chat':'watching'))); });
    var title = presetKey() === 'mix' ? '混合示例' : presetKey() === 'custom' ? '自由组合' : D.model.routeNames[presetKey()];
    $('lab-current').textContent = title + ' · ' + D.model.themeNames[s.theme] + ' · ' + ({entry:'入场',voice:'对话',watch:'观看'}[phase()]);
    $('lab-context').textContent = s.scene === 'entry' ? '点下方房间开始体验' : s.presenter === 'self' ? '我在演示共享' : s.presenter ? '朋友在演示共享' : '当前共享席位空闲';
    document.querySelectorAll('[data-world]').forEach(function (b) {
      var v = b.dataset.world;
      b.disabled = s.scene !== 'room' || (v === 'start' && (!!s.presenter || !s.members.some(function(m){return !m.self;}))) || (v === 'stop' && (!s.presenter || s.presenter === 'self')) || (v === 'join' && s.members.length >= 3) || (v === 'drop' && s.connection !== 'connected') || (v === 'restore' && s.connection === 'connected');
    });
  }
  function render(animate) {
    var focus = rememberFocus(); h = D.makeHelpers(s); var p = phase(), layout = D.layouts[s.layout[p]], fromPhase = previousPhase, fromRoute = previousRoute;
    canvas.dataset.theme = s.theme; canvas.dataset.layout = s.layout[p]; canvas.dataset.phase = p;
    var markup = layout[p](s, h);
    if ((s.error || s.micDenied || (s.scene === 'room' && s.connection !== 'connected')) && markup.indexOf('class="d-notice"') < 0) markup = h.notice(s) + markup;
    var changed = p !== previousPhase || s.layout[p] !== previousRoute;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    canvas.dataset.motion = reduced ? 'reduced' : 'standard';
    var canTransition = animate && changed && !reduced && !document.hidden && typeof document.startViewTransition === 'function';
    if (flipAnimation) { flipAnimation.cancel(); flipAnimation = null; }
    var flipSource = null, isPortalChange = fromRoute === 'portal' && s.layout[p] === 'portal' && ((fromPhase === 'entry' && p !== 'entry') || (fromPhase !== 'entry' && p === 'entry'));
    if (animate && changed && !canTransition && !reduced && isPortalChange) {
      var oldObject = fromPhase === 'entry' ? Array.from(surface.querySelectorAll('[data-room-id]')).find(function(node){return node.getAttribute('data-room-id')===joiningRoom;}) : surface.querySelector('.portal-room-shell');
      if (oldObject && oldObject.getBoundingClientRect) flipSource = oldObject.getBoundingClientRect();
    }
    var revision=++paintRevision;
    if(canTransition && previousPhase==='entry' && p!=='entry' && previousRoute==='portal' && s.layout[p]==='portal') {
      var source=Array.from(surface.querySelectorAll('[data-room-id]')).find(function(node){return node.getAttribute('data-room-id')===joiningRoom;});
      if(source)source.style.viewTransitionName='portal-room';
    }
    var paint = function () {
      if(revision!==paintRevision)return;
      surface.innerHTML = markup;
      var returnFocus = returnToDiscovery, returnCard = returningRoom && Array.from(surface.querySelectorAll('[data-room-id]')).find(function(node){return node.getAttribute('data-room-id')===returningRoom;});
      if (canTransition && fromPhase !== 'entry' && fromRoute === 'portal' && p === 'entry' && s.layout[p] === 'portal' && returningRoom) {
        if(returnCard) returnCard.style.viewTransitionName = 'portal-room';
      }
      returningRoom = ''; returnToDiscovery = false;
      var destinationObject = p === 'entry' ? returnCard : surface.querySelector('.portal-room-shell'), flipped = false;
      if (flipSource && destinationObject && destinationObject.animate && destinationObject.getBoundingClientRect) {
        var destinationBox = destinationObject.getBoundingClientRect();
        if (flipSource.width > 0 && flipSource.height > 0 && destinationBox.width > 0 && destinationBox.height > 0) {
          var transform = 'translate('+(flipSource.left-destinationBox.left)+'px,'+(flipSource.top-destinationBox.top)+'px) scale('+(flipSource.width/destinationBox.width)+','+(flipSource.height/destinationBox.height)+')';
          var activeFlip = destinationObject.animate([{transformOrigin:'top left',transform:transform,opacity:.75},{transformOrigin:'top left',transform:'none',opacity:1}],{duration:380,easing:'cubic-bezier(.22,.76,.25,1)'});
          flipAnimation = activeFlip; flipped = true; canvas.dataset.transition = 'running'; canvas.dataset.transitionMode = 'room-object';
          activeFlip.finished.catch(function(){}).finally(function(){if(flipAnimation===activeFlip){flipAnimation=null;canvas.dataset.transition='idle';}});
        }
      }
      if (animate && changed && !reduced && !canTransition && !flipped) {
        canvas.dataset.transitionMode = 'stage';
        surface.classList.remove('lab-stage-transition'); void surface.offsetWidth; surface.classList.add('lab-stage-transition');
      }
      renderLab(); drawOverlay(); syncFullscreenControls(); restoreFocus(focus);
      if (returnFocus && p === 'entry') {
        var afterReturn = returnCard && returnCard.querySelector('button:not(:disabled)') || surface.querySelector('h1') || canvas;
        if (/^H[1-6]$/.test(afterReturn.tagName)) afterReturn.setAttribute('tabindex','-1');
        afterReturn.focus({preventScroll:true});
      }
    };
    previousPhase = p; previousRoute = s.layout[p];
    if (transition && transition.skipTransition) transition.skipTransition();
    if (canTransition) {
      canvas.dataset.transition='running'; canvas.dataset.transitionMode='native';
      var activeTransition=document.startViewTransition(paint);transition=activeTransition;
      activeTransition.finished.catch(function () {}).finally(function () {if(transition===activeTransition){transition=null;canvas.dataset.transition='idle';}});
    } else {canvas.dataset.transition='idle';paint();}
  }
  function toast(text) {
    $('demo-toast').textContent = text; $('demo-toast').hidden = false; announce(text);
    window.clearTimeout(toastTimer); toastTimer = window.setTimeout(function () { $('demo-toast').hidden = true; }, 2600);
  }
  function busyThen(work) {
    var ticket = ++epoch; render();
    window.setTimeout(function () { if (ticket !== epoch) return; work(); s.busy = ''; render(true); }, 360);
  }
  function closeOverlay(restore) { overlay = null; overlayError = ''; layer.innerHTML = ''; if (restore !== false) restoreFocus(returnTarget); }
  function open(kind, anchor, text) {
    if (!overlay) returnTarget = rememberFocus(anchor);
    overlayError = ''; overlay = { kind: kind, anchor: anchor || null, anchorAction: anchor && anchor.dataset ? anchor.dataset.action : '', anchorValue: anchor && anchor.dataset ? anchor.dataset.value : undefined, text: text || '' }; drawOverlay();
    var first = layer.querySelector('form input:not([type=hidden]),form select,textarea') || layer.querySelector('button[data-action="close"]');
    if (first && first.focus) first.focus({preventScroll:true});
  }
  function titlebar(title) { return '<div class="d-dialog-top"><h2 id="demo-dialog-title">'+h.e(title)+'</h2>'+h.button('close','',{icon:'close',attrs:'aria-label="关闭面板"'})+'</div>'; }
  function field(id,label,value,type,attrs) { return '<label class="d-form-field" for="'+id+'">'+h.e(label)+'<input id="'+id+'" type="'+(type||'text')+'" value="'+h.e(value)+'" '+(attrs||'')+'></label>'; }
  function qualityOptions(value) { return ['1080p60','720p60','720p30'].map(function(v){return '<option value="'+v+'"'+(v===value?' selected':'')+'>'+({ '1080p60':'1080p · 60 FPS','720p60':'720p · 60 FPS','720p30':'720p · 30 FPS'}[v])+'</option>';}).join(''); }
  function drawOverlay() {
    if (!overlay) { layer.innerHTML=''; return; }
    var kind = overlay.kind, body = '', title = '', actions = '', error = overlayError ? '<p class="d-form-error" role="alert">'+h.e(overlayError)+'</p>' : '';
    if (kind === 'member' || kind === 'sound' || kind === 'room-menu') {
      title = kind === 'member' ? (overlay.text === 'self' ? '我的麦克风' : h.memberLabel(s,overlay.text) + '的声音') : kind === 'sound' ? '你听到的声音' : s.roomName;
      body = kind === 'member' ? h.personAudio(s,overlay.text) : kind === 'sound' ? h.audio(s) : '<div class="d-room-menu"><div class="d-room-meta">'+s.members.length+' / 3 人 · '+(s.owner?'你是房主':'你是成员')+'</div><ul>'+s.members.map(function(m){return '<li>'+h.e(h.memberLabel(s,m.id))+(s.presenter===m.id?' · 正在共享':'')+'</li>';}).join('')+'</ul><p>房间语音与观看独立。共享停止后可换人。</p>'+h.button(s.view==='watch'?'voice':'watch',s.view==='watch'?'只聊语音':'观看画面',{icon:'headphones',disabled:!s.presenter&&s.view!=='watch'})+h.button('settings','共享与声音设置',{icon:'settings'})+h.button('leave',s.owner?'结束房间':'离开房间',{icon:'leave',kind:'danger'})+'</div>';
      layer.innerHTML = '<div class="d-popover-shade" data-action="close"></div><section class="d-popover" role="dialog" aria-labelledby="demo-dialog-title">'+titlebar(title)+body+'</section>';
      var currentAnchor=overlay.anchor&&overlay.anchor.isConnected?overlay.anchor:Array.from(surface.querySelectorAll('[data-action]')).find(function(b){return b.dataset.action===overlay.anchorAction&&b.dataset.value===overlay.anchorValue;});
      var panel = layer.querySelector('.d-popover'), bounds = canvas.getBoundingClientRect(), anchor = currentAnchor ? currentAnchor.getBoundingClientRect() : {left:bounds.left+20,top:bounds.top+80,bottom:bounds.top+110};
      var width = Math.min(kind==='sound' && s.layout[phase()]==='edge' ? 420 : 340,Math.max(0,bounds.width-32));
      panel.style.width = width+'px';
      var height = panel.getBoundingClientRect().height || (kind==='sound'?365:400);
      var left = Math.max(16,Math.min(anchor.left-bounds.left,bounds.width-width-16));
      var top = anchor.top-bounds.top-height-12;
      if (top < 12) top = Math.min(anchor.bottom-bounds.top+12,Math.max(16,bounds.height-height-16));
      panel.style.left = left+'px'; panel.style.top = Math.max(16,top)+'px'; return;
    }
    if (kind === 'create') {
      title='创建一个房间'; body='<p>房间建好后先聊语音，任何人都能轮流共享。</p><form data-form="create">'+field('create-name','房间名称（可不填）',drafts.createName,'text','maxlength="32" autocomplete="off"')+'<label class="d-check"><input id="create-visible" type="checkbox" checked>允许附近的朋友发现并加入</label>'+error+'<div class="d-dialog-actions">'+h.button('close','取消')+h.button('confirm-create','创建房间',{icon:'plus',kind:'primary'})+'</div></form>';
    } else if (kind === 'manual') {
      title='手动加入'; body='<p>自动发现暂不可用时的备用入口。以下是演示数据，不会连接这些地址。</p><form data-form="manual">'+field('manual-address','房主局域网地址',drafts.manualAddress,'text','autocomplete="off"')+field('manual-port','端口',drafts.manualPort,'number','min="1" max="65535"')+field('manual-code','房间码',drafts.manualCode,'text','maxlength="8" autocomplete="off"')+error+'<div class="d-dialog-actions">'+h.button('close','取消')+h.button('confirm-manual','加入演示房间',{icon:'arrow-right',kind:'primary'})+'</div></form>';
    } else if (kind === 'share') {
      title='演示选屏'; body='<p>这里只模拟浏览器选屏流程，不会采集显示器或声音。</p><form data-form="share"><label class="d-source-choice"><input type="radio" name="demo-source" value="display-1"'+(s.selectedSource==='display-1'?' checked':'')+'>'+h.icon('screen')+'<span><strong>显示器 1 · 演示</strong><small>完整共享画面，切换游戏仍在同一块屏幕</small></span></label><label class="d-source-choice"><input type="radio" name="demo-source" value="display-2"'+(s.selectedSource==='display-2'?' checked':'')+'>'+h.icon('screen')+'<span><strong>显示器 2 · 演示</strong><small>用于比较选择状态</small></span></label><label class="d-check"><input id="capture-audio" type="checkbox"'+(s.shareAudio?' checked':'')+'>同时共享系统声音</label><label class="d-check"><input id="capture-cursor" type="checkbox"'+(s.cursor?' checked':'')+'>共享鼠标指针</label><label class="d-form-field" for="capture-quality">目标画质<select id="capture-quality">'+qualityOptions(s.quality)+'</select></label><p>声音隔离能力未确认时，仍可共享实际捕获到的系统声音。这里的选择仅演示界面反馈。</p>'+error+'<div class="d-dialog-actions">'+h.button('close','取消')+h.button('confirm-share','开始演示共享',{icon:'screen',kind:'primary'})+'</div></form>';
    } else if (kind === 'settings') {
      title='共享与声音设置'; body='<p>选择即时保留。画质是模拟目标档位，不代表实测帧率。</p><label class="d-form-field" for="settings-quality">我的共享画质<select id="settings-quality">'+qualityOptions(s.quality)+'</select></label><label class="d-check"><input id="settings-cursor" type="checkbox"'+(s.cursor?' checked':'')+'>共享我的鼠标</label><label class="d-check"><input id="settings-audio" type="checkbox"'+(s.shareAudio?' checked':'')+'>我的共享包含系统声音</label><h3>系统声音</h3><p>隔离能力：未确认（演示）。系统声音共享会继续；若听到回声，可以关闭系统声音或调整耳机收听。</p>'+(s.presenter==='self'&&s.systemShared?h.button('stop-system','只停止共享系统声音',{icon:'speaker-off'}):'')+'<h3>本机收听</h3>'+h.audio(s)+'<div class="d-dialog-actions">'+h.button('close','完成',{kind:'primary'})+'</div>';
    } else if (kind === 'leave') {
      title=s.owner?'结束这个房间？':'离开房间？'; body='<p>'+(s.owner?'你是房主。结束后，所有人都会离开这个房间。':'你的麦克风与共享会停止，其他朋友仍可留在房间。')+'</p><div class="d-dialog-actions">'+h.button('close','留在房间')+h.button('confirm-leave',s.owner?'结束房间':'离开房间',{icon:'leave',kind:'danger'})+'</div>';
    } else if (kind === 'mic-denied') {
      title='麦克风权限被拒绝 · 演示'; body='<p>你仍可观看和收听。真实产品中需要在浏览器检查麦克风权限；这里可以模拟重试成功。</p><div class="d-dialog-actions">'+h.button('close','暂不开启')+h.button('retry-mic','模拟重试成功',{icon:'mic',kind:'primary'})+'</div>';
    } else if (kind === 'invite') {
      title='邀请朋友 · 演示'; body='<p>真实使用时朋友打开程序后可在附近找到房间。下面是不可用于实际连接的演示加入信息。</p><textarea readonly aria-label="演示加入信息">'+h.e('演示房间：'+s.roomName+'\n演示地址：192.168.1.20:45678\n演示房间码：DEMO2026\n仅供原型体验，不可用于实际加入')+'</textarea><div class="d-dialog-actions">'+h.button('close','知道了',{kind:'primary'})+'</div>';
    } else if (kind === 'copy') {
      title='记录我的组合'; body='<p>这些是设计选择，复制给我后即可继续迭代。不会包含真实设备或房间信息。</p><textarea id="combo-text" readonly aria-label="当前组合">'+h.e(overlay.text)+'</textarea><div class="d-dialog-actions">'+h.button('copy-config','复制组合',{icon:'copy',kind:'primary'})+h.button('close','完成')+'</div>';
    }
    layer.innerHTML='<div class="d-dialog-backdrop"><section class="d-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-dialog-title">'+titlebar(title)+body+actions+'</section></div>';
  }
  function readPreferenceInputs(prefix) {
    if ($(prefix+'audio')) s.shareAudio=!!$(prefix+'audio').checked;
    if ($(prefix+'cursor')) s.cursor=!!$(prefix+'cursor').checked;
    if ($(prefix+'quality')) s.quality=$(prefix+'quality').value;
  }
  function join(room) {
    if (!room || room.full || room.count >= 3 || s.busy) return;
    s.busy='joining'; s.error=''; scenarioName='custom'; joiningRoom=room.id; s.joiningRoom=room.id; toast('正在加入演示房间…');
    busyThen(function () {
      s.scene='room'; s.owner=false; s.roomName=room.name; s.roomId=room.id; s.joiningRoom=''; s.connection='connected'; s.mic=false; s.micDenied=false;
      s.members=room.count>=2?D.model.members():[D.model.members()[0],D.model.members()[2]];
      s.presenter=room.sharing?'owner':null; s.view=s.presenter?'watch':'voice';
      announce('已加入房间，麦克风默认关闭'); toast('已加入 · 麦克风默认关闭');
    });
  }
  function resetScene(key) { ++epoch; closeOverlay(false); D.model.scenario(s,key); scenarioName=key; render(true); announce('已切换演示情境'); }
  function dispatch(action,value,anchor) {
    h=D.makeHelpers(s);
    if (action==='close') {closeOverlay();return;}
    if (action==='join') { join(s.rooms.find(function(r){return r.id===value;}));return; }
    if (action==='create'||action==='manual') {open(action,anchor);return;}
    if (action==='refresh'||(action==='retry'&&s.scene==='entry')) {s.discovery='searching';s.error='';s.busy='searching';busyThen(function(){s.discovery='ready';s.rooms=D.model.rooms();});return;}
    if (action==='confirm-create') {
      var name=$('create-name').value.trim()||'朋友的房间';
      if (Array.from(name).length>32||/[\x00-\x1f]/.test(name)) {overlayError='房间名最多 32 个字符。';drawOverlay();return;}
      ++epoch; s.scene='room';s.owner=true;s.roomName=name;s.members=[{id:'self',label:'房主',self:true}];s.presenter=null;s.mic=false;s.connection='connected';s.view='voice';s.busy='';s.error='';scenarioName='custom';closeOverlay(false);render(true);toast('房间已创建 · 可以先开启麦克风');return;
    }
    if (action==='confirm-manual') {
      var addr=$('manual-address').value.trim(),port=Number($('manual-port').value),code=$('manual-code').value.trim();
      var parts=addr.split('.').map(Number),privateIP=/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)&&parts.length===4&&parts.every(function(x){return Number.isInteger(x)&&x>=0&&x<=255;})&&(parts[0]===10||(parts[0]===192&&parts[1]===168)||(parts[0]===172&&parts[1]>=16&&parts[1]<=31));
      if (!privateIP||!Number.isInteger(port)||port<1||port>65535||!/^\w{8}$/.test(code)) {overlayError='请填写局域网 IPv4、1–65535 端口和 8 位房间码。';drawOverlay();return;}
      closeOverlay(false);join({id:'manual-demo',name:'手动加入的演示房间',count:2,sharing:false});return;
    }
    if (s.scene!=='room' && ['copy-config'].indexOf(action)<0) return;
    if (action==='mic') {if(s.micDenied){open('mic-denied',anchor);return;}s.mic=!s.mic;scenarioName='custom';render();announce(s.mic?'演示麦克风已开启':'演示麦克风已关闭');return;}
    if (action==='retry-mic') {s.micDenied=false;s.mic=true;closeOverlay(false);render();toast('演示重试成功，麦克风已开启');return;}
    if (action==='share') {if(s.presenter||s.connection!=='connected'){toast('当前不能开始共享，请等待席位空出或连接恢复');return;}open('share',anchor);return;}
    if (action==='confirm-share') {
      if(s.presenter||s.connection!=='connected'){overlayError='共享状态已变化，请关闭后重试。';drawOverlay();return;}
      readPreferenceInputs('capture-'); var choice=layer.querySelector('input[name="demo-source"]:checked');s.selectedSource=choice?choice.value:'display-1';
      s.presenter='self';s.systemShared=s.shareAudio;s.view='watch';scenarioName='custom';closeOverlay(false);render(true);toast('正在演示共享'+(s.systemShared?' · 系统声音已包含，隔离未确认':''));return;
    }
    if (action==='stop-share') {if(s.presenter!=='self')return;s.presenter=null;s.systemShared=false;s.view='voice';scenarioName='custom';closeOverlay(false);render(true);toast('共享已停止 · 麦克风状态保留');return;}
    if (action==='voice') {
      var wasSharing=s.presenter==='self';
      if(wasSharing){s.presenter=null;s.systemShared=false;}
      s.view='voice';scenarioName='custom';closeOverlay(false);render(true);
      announce(wasSharing?'共享已停止，麦克风状态保留，继续语音':'只聊语音，本机画面与共享声音不播放');return;
    }
    if (action==='watch') {if(!s.presenter){toast('当前还没有共享画面');return;}s.view='watch';scenarioName='custom';closeOverlay(false);render(true);return;}
    if (action==='member') {open('member',anchor,value);return;}
    if (action==='sound'||action==='room-menu'||action==='settings'||action==='invite'||action==='leave') {open(action,anchor);return;}
    if (action==='mute') {if(!Object.prototype.hasOwnProperty.call(s.muted,value)||value==='system'&&s.view==='voice')return;s.muted[value]=!s.muted[value];render();return;}
    if (action==='stop-system') {if(s.presenter==='self'){s.systemShared=false;s.shareAudio=false;render();toast('只停止了共享系统声音，画面与麦克风保留');}return;}
    if (action==='retry') {if(s.micDenied&&s.connection==='connected'){open('mic-denied',anchor);return;}s.connection='connected';s.error='';render();toast('演示连接已恢复');return;}
    if (action==='confirm-leave') {++epoch;returningRoom=s.roomId||'';returnToDiscovery=true;var prefs={layout:clone(s.layout),theme:s.theme};Object.assign(s,D.model.initial(),prefs);scenarioName='nearby';closeOverlay(false);if(document.fullscreenElement&&document.exitFullscreen)document.exitFullscreen().catch(function(){});render(true);toast('已离开演示房间');return;}
    if (action==='fullscreen') {
      if(!s.presenter)return;
      if(document.fullscreenElement){if(document.exitFullscreen)document.exitFullscreen().catch(function(){toast('未能退出全屏，可按 Esc');});}
      else if(canvas.requestFullscreen){Promise.resolve(canvas.requestFullscreen()).catch(function(){toast('浏览器未进入全屏，可使用“专心体验”扩大预览');});}
      else toast('当前环境未提供全屏，可使用“专心体验”扩大预览');return;
    }
    if (action==='copy-config') {
      var field=$('combo-text'); if(!field)return;var text=field.value;
      if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function(){toast('组合已复制');}).catch(function(){var box=$('combo-text');if(box&&box.select)box.select();toast(box?'请手动复制已选中的组合文字':'复制未完成，可以重新打开“记录我的组合”');});
      else {var area=$('combo-text');if(area&&area.select)area.select();toast('请手动复制组合文字');}return;
    }
  }
  function applyPreset(key) { if(key==='mix')s.layout={entry:'portal',voice:'orbit',watch:'edge'};else if(D.model.routeNames[key])s.layout={entry:key,voice:key,watch:key};render(true); }
  function world(key) {
    if(s.scene!=='room')return;scenarioName='custom';s.error='';
    if(key==='start'&&!s.presenter){var p=s.members.find(function(m){return !m.self;});if(p){s.presenter=p.id;s.systemShared=true;toast('朋友开始共享 · 你可以选择观看');}}
    if(key==='stop'&&s.presenter&&s.presenter!=='self'){s.presenter=null;s.systemShared=false;s.view='voice';toast('朋友停止共享 · 席位已空出');}
    if(key==='join'&&s.members.length<3){var id=s.members.some(function(m){return m.id==='friend';})?'owner':'friend';s.members.push({id:id,label:'成员 '+s.members.length,self:false});toast('一位演示朋友加入了');}
    if(key==='drop')s.connection='reconnecting';if(key==='restore'){s.connection='connected';toast('演示连接已恢复');}
    render(true);
  }
  function comboText() { return '入场：'+D.model.routeNames[s.layout.entry]+'\n语音：'+D.model.routeNames[s.layout.voice]+'\n观看：'+D.model.routeNames[s.layout.watch]+'\n风格：'+D.model.themeNames[s.theme]+'\n\n'+JSON.stringify({layout:s.layout,theme:s.theme},null,2); }
  function closeComparison() { $('comparison-panel').hidden=true;var trigger=document.querySelector('[data-lab="compare"]');if(trigger&&trigger.focus)trigger.focus({preventScroll:true}); }
  function setFocusMode(active) {
    document.body.classList.toggle('lab-focus',active);
    var exit=document.querySelector('.lab-exit-focus');exit.hidden=!active;
    var target=active?exit:document.querySelector('.lab-header-actions [data-lab="focus"]');
    if(target&&target.focus)target.focus({preventScroll:true});
  }
  function comparison() {
    var r=D.reviewData||{routes:[],fixed:[],recommendation:'',boundary:'尚未进行真实浏览器视觉验证。'};
    $('comparison-panel').innerHTML='<button class="lab-close" type="button" data-lab="close-compare" aria-label="关闭比较">关闭</button><h2>两轮方向，放在一起比较</h2><p>子智能体分别实现并交叉评审；下面是每种结构的取舍，还需要你的实际体验。</p><table><thead><tr><th>结构</th><th>保留的长处</th><th>需要付出的成本</th></tr></thead><tbody>'+r.routes.map(function(x){return '<tr><th>'+h.e(x.name)+'</th><td>'+h.e(x.strength)+'</td><td>'+h.e(x.cost)+'</td></tr>';}).join('')+'</tbody></table><h3>共同保留的原则</h3><ul>'+r.fixed.map(function(x){return '<li>'+h.e(x)+'</li>';}).join('')+'</ul><h3>一个混合示例</h3><p>'+h.e(r.recommendation)+'</p><button class="lab-apply-mix" data-lab="apply-mix" type="button">试试混合示例，保持当前风格</button><h3>你可以这样比较</h3><p>固定“朋友正在共享”，只换观看结构；固定“三人纯语音”，只换语音结构。再保留结构切换风格，比较麦克风、音量和离开能不能一眼找到。</p><p>'+h.e(r.boundary)+'</p>';
    $('comparison-panel').hidden=false;var close=$('comparison-panel').querySelector('button');if(close&&close.focus)close.focus();
  }
  document.addEventListener('click',function(event){
    var target=event.target.closest&&event.target.closest('button,[data-action="close"]');if(!target||target.disabled)return;
    if(target.dataset.action&&canvas.contains(target)){dispatch(target.dataset.action,target.dataset.value,target);return;}
    if(target.dataset.preset){applyPreset(target.dataset.preset);return;}
    if(target.dataset.style&&D.model.themeNames[target.dataset.style]){s.theme=target.dataset.style;render();return;}
    if(target.dataset.preview){resetScene(target.dataset.preview);return;}
    if(target.dataset.world){world(target.dataset.world);return;}
    var task=target.dataset.lab;if(!task)return;
    if(task==='focus')setFocusMode(!document.body.classList.contains('lab-focus'));
    if(task==='compare')comparison();if(task==='close-compare')closeComparison();
    if(task==='apply-mix'){applyPreset('mix');closeComparison();}
    if(task==='reset')resetScene('nearby');if(task==='copy'){h=D.makeHelpers(s);open('copy',target,comboText());}
  });
  document.addEventListener('change',function(event){
    var el=event.target,id=el.id;
    if(id==='focus-route'&&el.value!=='custom'){applyPreset(el.value);return;}
    if(/^layout-(entry|voice|watch)$/.test(id)&&D.model.routeNames[el.value]){s.layout[id.slice(7)]=el.value;render(true);return;}
    if(id==='theme-choice'&&D.model.themeNames[el.value]){s.theme=el.value;render();return;}
    if(id==='scenario-choice'&&el.value!=='custom'){resetScene(el.value);return;}
    if(id==='settings-quality'||id==='capture-quality')s.quality=el.value;
    if(id==='settings-cursor'||id==='capture-cursor')s.cursor=!!el.checked;
    if(id==='settings-audio'||id==='capture-audio')s.shareAudio=!!el.checked;
    if(id==='settings-audio'&&s.presenter==='self'){if(!s.shareAudio)s.systemShared=false;else if(!s.systemShared)toast('停止捕获的声音需要下次选屏时重新选择；当前画面继续');}
  });
  document.addEventListener('input',function(event){
    var el=event.target,ids={'create-name':'createName','manual-address':'manualAddress','manual-port':'manualPort','manual-code':'manualCode'};
    if(ids[el.id])drafts[ids[el.id]]=el.value;
    var key=el.getAttribute&&el.getAttribute('data-volume');
    if(key&&Object.prototype.hasOwnProperty.call(s.volumes,key)){
      var next=Number(el.value);if(!Number.isFinite(next))return;s.volumes[key]=Math.min(1,Math.max(0,next));
      var row=el.closest('.d-audio-row,.orbit-seat');var out=row&&row.querySelector('output');if(out)out.textContent=s.muted[key]?'已静音':Math.round(s.volumes[key]*100)+'%';
    }
  });
  document.addEventListener('submit',function(event){if(event.target.hasAttribute('data-form')){event.preventDefault();dispatch('confirm-'+event.target.dataset.form);}});
  document.addEventListener('keydown',function(event){
    if(event.key==='Escape'){
      if(!$('comparison-panel').hidden){closeComparison();event.preventDefault();return;}
      if(overlay){closeOverlay();event.preventDefault();return;}
      if(document.fullscreenElement&&document.exitFullscreen){document.exitFullscreen().catch(function(){toast('未能退出全屏，可以点退出全屏按钮');});event.preventDefault();return;}
      if(document.body.classList.contains('lab-focus')){setFocusMode(false);event.preventDefault();}
    }
    if(event.key==='Tab'&&overlay&&['sound','room-menu','member'].indexOf(overlay.kind)<0){
      var items=Array.from(layer.querySelectorAll('button:not(:disabled),input:not(:disabled),select,textarea,[tabindex="0"]'));
      if(!items.length)return;var first=items[0],last=items[items.length-1];
      if(event.shiftKey&&(document.activeElement===first||!layer.contains(document.activeElement))){last.focus();event.preventDefault();}
      else if(!event.shiftKey&&(document.activeElement===last||!layer.contains(document.activeElement))){first.focus();event.preventDefault();}
    }
  });
  function syncFullscreenControls(){
    var active=!!document.fullscreenElement;
    canvas.querySelectorAll('button[data-action="fullscreen"]').forEach(function(button){button.setAttribute('aria-pressed',String(active));if(button.lastElementChild)button.lastElementChild.textContent=active?'退出全屏':'全屏观看';});
  }
  document.addEventListener('fullscreenchange',function(){
    var active=!!document.fullscreenElement;
    syncFullscreenControls();
    if(overlay)drawOverlay();
    announce(active?'已进入浏览器全屏，可按 Esc 退出':'已退出浏览器全屏');
  });
  D.app={getState:function(){return clone(s);},dispatch:dispatch,setScenario:resetScene};
  render();
}());
