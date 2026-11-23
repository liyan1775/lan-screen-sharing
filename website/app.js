const spring = name => name === 'bouncy' ? 'cubic-bezier(.25, 1.48, .5, 1)' : 'cubic-bezier(.25, 1, .5, 1)';
const tabs = [...document.querySelectorAll('[role="tab"]')];
const tabList = document.querySelector('.gallery-tabs');
function selectTab(tab, focus = false) {
  tabList.style.setProperty('--segment-index', tabs.indexOf(tab));
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next !== null) { event.preventDefault(); selectTab(tabs[next], true); }
  });
}
const flow = document.querySelector('.flow');
const compare = document.querySelector('.compare-toggle');
const compareButtons = [...compare.querySelectorAll('[data-compare]')];
const encoders = [...flow.querySelectorAll('.encoder')];
let encoderAnimations = [];
let pulseAnimations = [];
let flowVisible = !('IntersectionObserver' in window);
function updatePulses() {
  pulseAnimations.forEach(animation => animation.cancel());
  pulseAnimations = [];
  if (!flowVisible) return;
  const wires = flow.querySelector('.wires-' + flow.dataset.state);
  for (const [index, pulse] of [...wires.querySelectorAll('.flow-pulse')].entries()) {
    const path = pulse.previousElementSibling;
    const length = path.getTotalLength();
    const frames = Array.from({length: 33}, (_, step) => {
      const {x, y} = path.getPointAtLength(length * step / 32);
      return {
        transform: `translate(${x}px, ${y}px)`,
        opacity: Math.min(.86, step / 3, (32 - step) / 3),
      };
    });
    pulseAnimations.push(pulse.animate(frames, {
      duration: 2850,
      delay: index * 360,
      iterations: Infinity,
    }));
  }
}
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(([entry]) => {
    flowVisible = entry.isIntersecting;
    updatePulses();
  });
  observer.observe(flow);
}
updatePulses();
for (const [index, button] of compareButtons.entries()) button.addEventListener('click', () => {
  if (button.getAttribute('aria-pressed') === 'true') return;
  const before = button.dataset.compare === 'before';
  const start = encoders[0].getBoundingClientRect().top;
  encoderAnimations.forEach(animation => animation.cancel());
  compare.style.setProperty('--compare-index', index);
  for (const item of compareButtons) item.setAttribute('aria-pressed', String(item === button));
  flow.dataset.state = before ? 'before' : 'after';
  const shift = start - encoders[0].getBoundingClientRect().top;
  const timing = {duration: 420, easing: spring('bouncy')};
  encoderAnimations = [
    encoders[0].animate([
      {translate: `0 ${shift}px`, scale: .975},
      {translate: '0 0', scale: 1},
    ], timing),
  ];
  if (before) encoderAnimations.push(encoders[1].animate([
    {opacity: 0, transform: 'translateY(6px) scale(.94)'},
    {opacity: 1, transform: 'translateY(0) scale(1)'},
  ], timing));
  updatePulses();
  flow.setAttribute('aria-label', before ? '升级前为两位观众分别编码，共编码两次' : 'v1.0.0 只编码一次，将同一份编码画面发送给两位观众');
  document.getElementById('encoding-caption').textContent = before ? '分别为两位观众编码' : '同一份编码画面';
  document.querySelector('.compare-description').textContent = before
    ? '分享端为两位观众分别编码相同的画面。'
    : '编码一次。分享者的本机程序把同一份画面分别发给两位观众。';
});

const select = selector => document.querySelector(selector);
const selectAll = selector => [...document.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const header = select('.product-header');
const hero = select('.hero');
const showcase = select('#heroShowcase');
const heroStage = showcase.querySelector('.hero-stage');
const lines = selectAll('.story-line');
const privacy = select('#privacy');
const links = selectAll('.nav-links a');
const sections = links.map(link => select(link.hash));

if ('IntersectionObserver' in window) {
  document.documentElement.classList.add('motion-ready');
  const revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      } else {
        entry.target.dataset.revealFrom = entry.boundingClientRect.top < 0 ? 'top' : 'bottom';
        entry.target.classList.remove('is-visible');
      }
    }
  });
  for (const item of selectAll('.reveal')) revealObserver.observe(item);
}

let scrollFrame = 0;
let heroScroll = 0;
let heroLeftView = false;
function updateScroll() {
  scrollFrame = 0;
  const heroRect = hero.getBoundingClientRect();
  const privacyRect = privacy.getBoundingClientRect();
  const storyPositions = lines.map(line => line.getBoundingClientRect().top);
  const navigationTop = header.offsetHeight + 56;
  const currentSection = sections.findLast(section => section.getBoundingClientRect().top <= navigationTop) ?? sections[0];
  if (header.dataset.currentSection !== currentSection.id) {
    header.dataset.currentSection = currentSection.id;
    for (const link of links) {
      if (link.hash === `#${currentSection.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  for (const [index, line] of lines.entries()) {
    line.classList.toggle('lit', storyPositions[index] < innerHeight * (.76 - index * .11));
  }
  header.dataset.scrolled = String(scrollY > 2);
  heroScroll = clamp(scrollY / (hero.offsetHeight * .85), 0, 1);
  if (heroRect.bottom <= 60) heroLeftView = true;
  else if (heroLeftView && scrollY <= 100 && typeof playIntro === 'function') {
    heroLeftView = false;
    playIntro();
  }
  showcase.style.setProperty('--stage-scale', (1 + heroScroll * .045).toFixed(4));
  showcase.style.setProperty('--stage-shift', `${-heroScroll * 20}px`);
  const progress = (innerHeight / 2 - privacyRect.top - privacyRect.height / 2) / (innerHeight + privacyRect.height);
  privacy.style.setProperty('--parallax', `${clamp(progress, -.5, .5) * Math.min(84, privacyRect.height * .12)}px`);
}
function queueScroll() {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll);
}
addEventListener('scroll', queueScroll, {passive: true});
addEventListener('resize', queueScroll);
updateScroll();

for (const card of selectAll('.bento-card, .step-card, #simulator')) {
  card.addEventListener('mousemove', event => {
    const panel = card.matches('#simulator') ? card.querySelector('.sim-console') : card;
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    panel.style.setProperty('--my', `${event.clientY - rect.top}px`);
  });
}

function setupSegments(root, selector, onChange) {
  const buttons = [...root.querySelectorAll(selector)];
  for (const [index, button] of buttons.entries()) button.addEventListener('click', () => {
    root.style.setProperty('--compare-index', index);
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    onChange(button);
  });
}

const compareBox = select('#compareBox');
const slider = select('#compareHandle');
function setSplit(value) {
  slider.value = value;
  slider.setAttribute('aria-valuetext', `${slider.value}% 清晰画面`);
  compareBox.style.setProperty('--split', `${slider.value}%`);
}
slider.addEventListener('input', () => setSplit(slider.value));
let dragPointer = null;
function dragSplit(event) {
  const rect = compareBox.getBoundingClientRect();
  setSplit(Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * 100));
}
slider.addEventListener('pointerdown', event => {
  if (event.button !== 0 || dragPointer !== null) return;
  event.preventDefault();
  if (event.pointerType !== 'touch') slider.focus({preventScroll: true});
  dragPointer = event.pointerId;
  slider.setPointerCapture(dragPointer);
  dragSplit(event);
});
slider.addEventListener('pointermove', event => {
  if (event.pointerId === dragPointer) dragSplit(event);
});
slider.addEventListener('lostpointercapture', () => { dragPointer = null; });
setupSegments(select('.clarity-toggle'), '[data-clarity]', button => {
  compareBox.dataset.quality = button.dataset.clarity;
});

const sim = select('.sim-console');
const shareButton = select('#toggleShareBtn');
const simSurface = select('#simSurface');
const standby = select('#receiverStandby');
const copyButton = select('#copyInviteBtn');
const profileLabels = {'1080p60': '1080p · 60fps', '720p60': '720p · 60fps', '720p30': '720p · 30fps'};
const simState = {
  sharing: false, mode: '1080p60', pointerActive: false,
  pointer: {x: .52, y: .55}, receiverPointer: {x: .52, y: .55}, ripples: [],
};
const delaySeconds = .075;
function renderSimStatus() {
  const live = simState.sharing;
  sim.dataset.sharing = String(live);
  shareButton.textContent = live ? '停止共享' : '开始共享屏幕';
  select('#hostStatusText').textContent = live ? '正在局域网共享' : '待机中';
  standby.inert = live;
  select('#telEncoding').textContent = live ? '1 次复用' : '—';
  select('#telQuality').textContent = live ? profileLabels[simState.mode] : '—';
  select('#telConnection').textContent = live ? '局域网直连' : '未连接';
}
shareButton.addEventListener('click', () => {
  simState.sharing = !simState.sharing;
  if (simState.sharing) Object.assign(simState.receiverPointer, simState.pointer);
  renderSimStatus();
});
setupSegments(select('.sim-modes'), '[data-mode]', button => {
  simState.mode = button.dataset.mode;
  renderSimStatus();
});
function trackPointer(event) {
  const rect = simSurface.getBoundingClientRect();
  simState.pointer.x = clamp((event.clientX - rect.left) / rect.width, .035, .965);
  simState.pointer.y = clamp((event.clientY - rect.top) / rect.height, .05, .94);
  simState.pointerActive = true;
}
simSurface.addEventListener('pointermove', trackPointer);
simSurface.addEventListener('pointerleave', () => { simState.pointerActive = false; });
simSurface.addEventListener('click', event => {
  if (event.detail) trackPointer(event);
  simState.ripples.push({...simState.pointer, start: performance.now() / 1000});
  if (simState.ripples.length > 12) simState.ripples.shift();
});
let copyTimer;
copyButton.addEventListener('click', async () => {
  const invite = select('#simInvite');
  const code = `${invite.firstChild.textContent}  ${invite.lastChild.textContent}`;
  let copied = false;
  try {
    await navigator.clipboard.writeText(code);
    copied = true;
  } catch {
    const field = document.createElement('textarea');
    field.value = code;
    field.className = 'sr-only';
    field.readOnly = true;
    invite.after(field);
    field.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    field.remove();
    copyButton.focus({preventScroll: true});
  }
  if (!copied) getSelection().selectAllChildren(invite);
  select('#copyStatus').textContent = copied ? '示例邀请已复制' : '无法自动复制，已选中示例邀请，请手动复制。';
  copyButton.textContent = copied ? '已复制' : '复制';
  copyButton.toggleAttribute('data-copied', copied);
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyButton.textContent = '复制';
    copyButton.removeAttribute('data-copied');
    select('#copyStatus').textContent = '';
  }, 2200);
});

const canvasIds = ['heroHostCanvas', 'heroViewerACanvas', 'heroViewerBCanvas', 'encodingWaveCanvas', 'simHostCanvas', 'simReceiverCanvas'];
const surfaces = canvasIds.map(id => {
  const canvas = document.getElementById(id);
  return {canvas, context: canvas.getContext('2d', {alpha: false})};
});
const [heroHost, heroA, heroB, wave, simHost, simReceiver] = surfaces;
const sceneWidth = 960;
const sceneHeight = 540;
const aura = select('#heroAuraCanvas');
const auraContext = aura.getContext('2d');
const palette = getComputedStyle(document.documentElement);
const ice = palette.getPropertyValue('--accent-text').trim();
const violet = palette.getPropertyValue('--wisteria').trim();
const porcelain = palette.getPropertyValue('--text').trim();
const ruby = palette.getPropertyValue('--ruby').trim();
const devices = showcase.querySelector('.devices');
const hostDevice = devices.querySelector('.device-host');
const beamBranches = selectAll('.beam-branch').map((branch, index) => ({
  viewer: devices.querySelector(index ? '.viewer-b' : '.viewer-a'),
  track: branch.querySelector('.beam-track'),
  path: branch.querySelector('.beam-path'),
  particle: branch.querySelector('.beam-particle'),
  length: 0,
}));
const replay = select('#heroReplay');
let introStart;
function playIntro() {
  heroLeftView = false;
  delete hero.dataset.intro;
  // Flush the old animation state so a second click can restart it mid-play.
  void heroStage.offsetWidth;
  introStart = performance.now() / 1000;
  hero.dataset.intro = 'playing';
  drawBeams(0);
}
heroStage.addEventListener('animationend', event => {
  if (event.target === heroStage && event.animationName === 'stage-rise') {
    hero.dataset.intro = 'complete';
    drawBeams(Math.max(2, performance.now() / 1000 - introStart));
  }
});
replay.hidden = false;
replay.addEventListener('click', () => {
  scrollTo({top: 0, behavior: 'instant'});
  updateScroll();
  playIntro();
});
playIntro();

function resizeBeams() {
  const stacked = hostDevice.offsetTop < beamBranches[0].viewer.offsetTop &&
    hostDevice.offsetTop + hostDevice.offsetHeight < beamBranches[0].viewer.offsetTop;
  for (const [index, branch] of beamBranches.entries()) {
    const {viewer, track, path} = branch;
    const direction = index ? 1 : -1;
    const hostFrameHeight = hostDevice.firstElementChild.offsetHeight;
    const viewerFrameHeight = viewer.firstElementChild.offsetHeight;
    const startX = hostDevice.offsetLeft + hostDevice.offsetWidth * (stacked ? .5 + direction * .19 : index);
    const startY = hostDevice.offsetTop + hostFrameHeight * (stacked ? .91 : .43);
    const endX = viewer.offsetLeft + viewer.offsetWidth * (stacked ? .5 : .5 - direction * .32);
    const endY = viewer.offsetTop + viewerFrameHeight * (stacked ? .21 : .42);
    const bow = stacked ? 30 : Math.max(34, hostFrameHeight * .24);
    const controlX = (startX + endX) / 2;
    const curve = stacked
      ? `M${startX} ${startY} C${startX} ${startY + bow} ${endX} ${endY - bow} ${endX} ${endY}`
      : `M${startX} ${startY} C${controlX} ${startY - bow} ${controlX} ${endY + bow} ${endX} ${endY}`;
    track.setAttribute('d', curve);
    path.setAttribute('d', curve);
    branch.length = path.getTotalLength();
    track.style.strokeDasharray = path.style.strokeDasharray = `${branch.length}`;
  }
  drawBeams(performance.now() / 1000 - introStart);
}
function drawBeams(elapsed) {
  const sending = clamp((elapsed - .7) / .45, 0, 1);
  for (const [index, {path, track, particle, length}] of beamBranches.entries()) {
    if (!length) continue;
    path.style.strokeDashoffset = track.style.strokeDashoffset = length * (1 - sending);
    const cycle = ((elapsed - 1.8 + 2.2 - index * .09) % 2.2) / .76;
    const progress = sending < 1 ? sending : clamp(cycle, 0, 1);
    const {x, y} = path.getPointAtLength(progress * length);
    particle.setAttribute('cx', x);
    particle.setAttribute('cy', y);
    particle.style.opacity = clamp(Math.min(progress, 1 - progress) * 8, 0, 1);
  }
}

const turn = Math.PI * 2;
const dust = Array.from({length: 76}, (_, index) => ({
  angle: index * 2.39996, distance: .3 + (index * .38197 % 1) * 1.42,
  phase: index * 1.73, size: index % 8 ? .65 : 1.25,
}));
function drawAura(time) {
  const context = auraContext;
  const width = aura.clientWidth;
  const height = aura.clientHeight;
  if (!width || !height) return;
  const elapsed = Math.max(0, time - introStart);
  const bloom = 1 - (1 - clamp(elapsed / 1.2, 0, 1)) ** 3;
  const core = (1 - bloom) ** 2;
  const radius = Math.min(width * (width < 701 ? .65 : .37), height * .65, 530);
  const centerY = height * (width < 701 ? .58 : .53);
  const expansion = (.64 + .36 * bloom) * (1 + heroScroll * .22);
  context.setTransform(aura.width / width, 0, 0, aura.height / height, 0, 0);
  context.clearRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, centerY - heroScroll * 34);
  context.scale(expansion, expansion * .79);
  const fade = 1 - heroScroll * .94;

  const nucleus = context.createRadialGradient(0, 0, 0, 0, 0, radius * .86);
  nucleus.addColorStop(0, '#ddfaff');
  nucleus.addColorStop(.05, ice);
  nucleus.addColorStop(.27, '#27555c86');
  nucleus.addColorStop(.75, '#42346438');
  nucleus.addColorStop(1, '#42346400');
  context.globalAlpha = fade * (.28 + .71 * core);
  context.fillStyle = nucleus;
  context.fillRect(-radius, -radius, radius * 2, radius * 2);

  // Six and eight soft caustics sit inside the etched metal rings.
  for (const [count, scale, tone, drift] of [[6, .66, ice, .048], [8, .91, violet, -.032]]) {
    for (let petal = 0; petal < count; petal++) {
      const angle = petal * turn / count + time * drift;
      const breath = .55 + .45 * Math.sin(time * .72 + petal * 1.7);
      context.save();
      context.rotate(angle);
      context.translate(radius * scale, 0);
      context.scale(1, .37);
      const length = radius * .47;
      const light = context.createRadialGradient(0, 0, 0, 0, 0, length);
      light.addColorStop(0, `${tone}52`);
      light.addColorStop(.42, `${tone}20`);
      light.addColorStop(1, `${tone}00`);
      context.globalAlpha = fade * (.4 + breath * .49) * (.55 + bloom * .45);
      context.fillStyle = light;
      context.fillRect(-length, -length, length * 2, length * 2);
      context.restore();
    }
  }

  for (const [index, scale] of [.76, .89, 1].entries()) {
    const distance = radius * scale;
    const angle = time * (index % 2 ? -.058 : .037) + index * .64;
    context.save();
    context.rotate(angle);
    const metal = context.createConicGradient(index * .9, 0, 0);
    metal.addColorStop(0, '#bce7ed12');
    metal.addColorStop(.18, '#a2e4edba');
    metal.addColorStop(.38, '#bce7ed19');
    metal.addColorStop(.63, '#c7b8f9a1');
    metal.addColorStop(.79, '#e9fafc98');
    metal.addColorStop(1, '#bce7ed12');
    context.globalAlpha = fade * (.45 + bloom * .55);
    context.strokeStyle = metal;
    context.lineWidth = index === 1 ? .7 : 1.1;
    context.beginPath();
    context.arc(0, 0, distance, 0, turn);
    context.stroke();
    const ticks = index === 2 ? 144 : 96;
    context.beginPath();
    for (let tick = 0; tick < ticks; tick++) {
      const theta = tick * turn / ticks;
      const x = Math.cos(theta);
      const y = Math.sin(theta);
      const length = tick % 12 ? 2 : 9;
      context.moveTo(x * (distance + 4), y * (distance + 4));
      context.lineTo(x * (distance + 4 + length), y * (distance + 4 + length));
    }
    context.stroke();
    if (index === 2) {
      context.fillStyle = ruby;
      context.shadowColor = ruby;
      context.shadowBlur = 10;
      for (const theta of [2.84, 3.95]) {
        context.beginPath();
        context.arc(Math.cos(theta) * distance, Math.sin(theta) * distance, 2, 0, turn);
        context.fill();
      }
    }
    context.restore();
  }
  for (const grain of dust) {
    const angle = grain.angle + time * .026;
    const distance = radius * grain.distance + Math.sin(time * .62 + grain.phase) * 6;
    context.globalAlpha = fade * (.18 + .42 * (.5 + .5 * Math.sin(time * 1.2 + grain.phase)));
    context.fillStyle = grain.size > 1 ? violet : porcelain;
    context.beginPath();
    context.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, grain.size, 0, turn);
    context.fill();
  }
  context.restore();
}

const canvasGroups = [hero, wave.canvas.parentElement, sim];
const activeCanvases = new Set(canvasGroups);
if ('IntersectionObserver' in window) {
  const canvasObserver = new IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      if (isIntersecting) activeCanvases.add(target);
      else activeCanvases.delete(target);
    }
    queueAnimation();
  }, {rootMargin: '100px'});
  canvasGroups.forEach(group => canvasObserver.observe(group));
}

const canvasResize = new ResizeObserver(entries => {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  for (const {target, contentRect} of entries) {
    const width = Math.max(1, Math.round(contentRect.width * ratio));
    const height = Math.max(1, Math.round(contentRect.height * ratio));
    if (width !== target.width || height !== target.height) {
      target.width = width;
      target.height = height;
    }
  }
  drawAura(performance.now() / 1000);
  drawHero(performance.now() / 1000);
  drawWave(performance.now() / 1000);
  drawSimulator(performance.now() / 1000, 0);
});
surfaces.forEach(({canvas}) => canvasResize.observe(canvas));
canvasResize.observe(aura);
new ResizeObserver(resizeBeams).observe(devices);

function canvasBox(context, left, top, width, height, radius, fill, stroke) {
  context.beginPath();
  context.roundRect(left, top, width, height, radius);
  context.fillStyle = fill;
  context.fill();
  if (stroke) { context.strokeStyle = stroke; context.stroke(); }
}

function drawGrid(context, width, height, spacing, color) {
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.beginPath();
  for (let offset = spacing; offset < width; offset += spacing) {
    context.moveTo(offset, 0); context.lineTo(offset, height);
  }
  for (let offset = spacing; offset < height; offset += spacing) {
    context.moveTo(0, offset); context.lineTo(width, offset);
  }
  context.stroke();
}

function drawCursor(context, x, y, radius = 38) {
  const glow = context.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, '#c6f6f5bd');
  glow.addColorStop(.24, '#7ee2ee75');
  glow.addColorStop(1, '#b2a0e600');
  context.fillStyle = glow;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  context.save();
  context.translate(x, y);
  context.beginPath();
  context.moveTo(0, 0); context.lineTo(2, 23); context.lineTo(8, 17);
  context.lineTo(13, 26); context.lineTo(17, 24); context.lineTo(12, 15); context.lineTo(21, 14); context.closePath();
  context.fillStyle = '#fff';
  context.strokeStyle = '#19414c';
  context.lineWidth = 1.4;
  context.fill(); context.stroke(); context.restore();
}

const peacockMetal = [[0, '#081318'], [.16, '#175761'], [.24, ice], [.31, '#20565e'],
  [.48, '#101b25'], [.64, '#53456e'], [.73, violet], [.81, '#334153'], [1, '#0c191e']];
const frostMetal = [[0, '#122831'], [.12, '#317480'], [.2, '#e2f4f5'], [.27, '#72969e'],
  [.35, '#17353c'], [.51, ice], [.62, '#263142'], [.76, '#695981'], [.85, '#d4c4f1'],
  [.92, '#667882'], [1, '#0c1e25']];

function drawRibbon(context, time, phase, colors) {
  const lift = Math.sin(time * .84 + phase) * 34;
  const twist = Math.cos(time * .72 + phase) * 42;
  const wing = phase === 0 ? 0 : 78;
  const edge = new Path2D();
  edge.moveTo(-75, 373 - wing);
  edge.bezierCurveTo(150, 65 + lift + wing, 275, 95 - twist, 525, 288);
  edge.bezierCurveTo(765, 460 - lift, 885, 197 + twist - wing, 1195, 135 + wing);
  edge.bezierCurveTo(960, 264 + twist - wing, 796, 528 - lift, 518, 318);
  edge.bezierCurveTo(267, 131 - twist, 159, 181 + lift + wing, -75, 429 - wing);
  edge.closePath();

  const metal = context.createLinearGradient(125, 78 + lift, 1130, 344 - twist);
  colors.forEach(([position, color]) => metal.addColorStop(position, color));
  context.fillStyle = metal;
  context.fill(edge);
  const sheen = context.createLinearGradient(0, 88 + lift, 140, 430 - lift);
  sheen.addColorStop(0, '#0611179e');
  sheen.addColorStop(.29, '#070d1700');
  sheen.addColorStop(.42, '#d3f1f560');
  sheen.addColorStop(.48, '#bbeaed08');
  sheen.addColorStop(.57, '#07081491');
  sheen.addColorStop(.84, '#33274900');
  sheen.addColorStop(1, '#2019319e');
  context.fillStyle = sheen;
  context.fill(edge);
  context.strokeStyle = metal;
  context.lineWidth = 1.2;
  context.stroke(edge);
}

function drawHero(time) {
  const width = sceneWidth, height = sceneHeight;
  const {canvas: hostFrame, context} = heroHost;
  context.setTransform(hostFrame.width / width, 0, 0, hostFrame.height / height, 0, 0);
  const backdrop = context.createLinearGradient(0, 0, width, height);
  backdrop.addColorStop(0, '#071015'); backdrop.addColorStop(.54, '#142834'); backdrop.addColorStop(1, '#120f1c');
  context.fillStyle = backdrop; context.fillRect(0, 0, width, height);
  const wash = context.createRadialGradient(width * .61, height * .62, 4, width * .61, height * .62, 430);
  wash.addColorStop(0, '#20788482'); wash.addColorStop(1, '#10162200');
  context.fillStyle = wash; context.fillRect(0, 0, width, height);
  drawGrid(context, width, height, 36, '#b8e4ea12');
  context.save();
  context.scale(width / 1120, height / 514);
  drawRibbon(context, time, 2.5, peacockMetal);
  drawRibbon(context, time, 0, frostMetal);
  context.restore();
  context.lineWidth = 1.4;
  canvasBox(context, 226, 133, 510, 272, 22, '#13232bd8', '#b7e5ed58');
  canvasBox(context, 248, 154, 466, 35, 8, '#c1e7eb11');
  for (const [index, color] of ['#7ee2ee', '#c3eced', '#b2a0e6'].entries()) {
    canvasBox(context, 260 + index * 16, 167, 7, 7, 4, color);
  }
  context.font = '600 12px system-ui,sans-serif'; context.fillStyle = '#d7e7ec';
  context.fillText('LAN STUDIO   /   SHARED WORKSPACE', 350, 175);
  canvasBox(context, 248, 207, 136, 171, 10, '#c5e7eb0b', '#c5e7eb22');
  canvasBox(context, 398, 207, 316, 171, 10, '#071416b3', '#c5e7eb24');
  for (let index = 0; index < 5; index++) {
    canvasBox(context, 265, 229 + index * 25, 55 + index % 3 * 16, 5, 2, index === 1 ? '#7ee2ee' : '#8cabb675');
    canvasBox(context, 422, 229 + index * 26, 112 + 115 * (.5 + .5 * Math.sin(time * 1.05 + index * 1.73)), 5, 2, ['#7ee2ee','#4da8b6d0','#dceaf49a','#b2a0e6cc','#7ee2eebf'][index]);
  }
  drawCursor(context, width * (.56 + Math.cos(time * .84) * .22), height * (.52 + Math.sin(time * 1.1) * .18));
  for (const {canvas, context: screen} of [heroA, heroB]) {
    screen.drawImage(hostFrame, 0, 0, canvas.width, canvas.height);
  }
}

function drawWave(time) {
  const {canvas, context} = wave;
  const width = canvas.width, height = canvas.height;
  context.fillStyle = '#0a1016'; context.fillRect(0, 0, width, height);
  drawGrid(context, width, height, width / 21, '#aad7df1b');
  context.strokeStyle = '#a0cad842'; context.beginPath();
  context.moveTo(0, height * .54); context.lineTo(width, height * .54); context.stroke();
  for (let layer = 0; layer < 2; layer++) {
    context.beginPath();
    for (let step = 0; step <= 110; step++) {
      const t = step / 110;
      const power = Math.sin(t * Math.PI) * (.65 + .35 * Math.sin(3 * t + time * .65));
      const signal = Math.sin(t * 17 - time * 2.4 + layer * .6) + .27 * Math.sin(t * 37 - time * 3.5);
      const y = height * (.54 + power * signal * (layer ? .19 : .26));
      if (step === 0) context.moveTo(0, y); else context.lineTo(width * t, y);
    }
    context.strokeStyle = layer ? '#7ee2ee' : '#b2a0e6a0';
    context.lineWidth = Math.max(1.5, height / (layer ? 94 : 59));
    context.shadowBlur = layer ? 8 : 18;
    context.shadowColor = layer ? '#7ee2ee' : '#b2a0e6';
    context.stroke();
  }
  context.shadowBlur = 0;
}

function drawWorkspace(surface, time, pointer) {
  const {canvas, context} = surface;
  const width = sceneWidth, height = sceneHeight;
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  const backdrop = context.createLinearGradient(0, 0, width, height);
  backdrop.addColorStop(0, '#172e35'); backdrop.addColorStop(1, '#070d14');
  context.fillStyle = backdrop; context.fillRect(0, 0, width, height);
  drawGrid(context, width, height, 43, '#b5dce619');
  const x = pointer.x * width, y = pointer.y * height;
  const orb = context.createRadialGradient(x, y, 0, x, y, 306);
  orb.addColorStop(0, '#4ac6ce88'); orb.addColorStop(.42, '#ad95ed42'); orb.addColorStop(1, '#b2a0e600');
  context.fillStyle = orb; context.fillRect(0, 0, width, height);
  canvasBox(context, 107, 91, 746, 351, 24, '#101e24cd', '#c6f0f55c');
  context.font = '650 29px system-ui,sans-serif'; context.fillStyle = '#e9f5ff';
  context.fillText('LAN Studio / Shared Desktop', 151, 162);
  context.font = '600 19px Consolas,monospace'; context.fillStyle = '#7ee2ee';
  context.fillText(`${simState.mode.toUpperCase()}   /   LOCAL DEMO`, 151, 204);
  for (let index = 0; index < 24; index++) {
    const bar = 20 + Math.abs(Math.sin(time * 2.7 + index * .42) * Math.cos(index * .16 + time * .6)) * 116;
    canvasBox(context, 151 + index * 28, 396 - bar, 12, bar, 4, index % 3 ? '#4ba7b1b9' : '#b2a0e6d9');
  }
  for (const ripple of simState.ripples) {
    const age = time - ripple.start;
    if (age < 0 || age >= 1) continue;
    context.beginPath(); context.arc(ripple.x * width, ripple.y * height, 11 + age * 147, 0, Math.PI * 2);
    context.lineWidth = 3; context.strokeStyle = `rgba(178, 160, 230, ${.9 * (1 - age)})`; context.stroke();
  }
  drawCursor(context, x, y, 58);
}

function drawSimulator(time, delta) {
  if (!simState.pointerActive) {
    simState.pointer.x = .5 + .24 * Math.cos(time * .79);
    simState.pointer.y = .55 + .13 * Math.sin(time * 1.06);
  }
  const mix = 1 - Math.exp(-delta / delaySeconds);
  simState.receiverPointer.x += (simState.pointer.x - simState.receiverPointer.x) * mix;
  simState.receiverPointer.y += (simState.pointer.y - simState.receiverPointer.y) * mix;
  simState.ripples = simState.ripples.filter(ripple => time - ripple.start < 1 + delaySeconds);
  drawWorkspace(simHost, time, simState.pointer);
  if (simState.sharing) drawWorkspace(simReceiver, time - delaySeconds, simState.receiverPointer);
}

let animationFrame = 0;
let lastDraw = 0;
let nextDraw = 0;
const frameSeconds = 1 / 60;
function queueAnimation() {
  if (!animationFrame && activeCanvases.size && !document.hidden) animationFrame = requestAnimationFrame(animate);
}
function animate(now) {
  animationFrame = 0;
  const time = now / 1000;
  if (time + .001 >= nextDraw) {
    const delta = Math.min(.08, time - lastDraw);
    if (activeCanvases.has(hero)) {
      drawAura(time);
      drawHero(time);
      drawBeams(time - introStart);
    }
    if (activeCanvases.has(wave.canvas.parentElement)) drawWave(time);
    if (activeCanvases.has(sim)) drawSimulator(time, delta);
    lastDraw = time;
    nextDraw = nextDraw && time - nextDraw < frameSeconds * 2 ? nextDraw + frameSeconds : time + frameSeconds;
  }
  queueAnimation();
}
document.addEventListener('visibilitychange', queueAnimation);
queueAnimation();

function setupGalleryScreen() {
  const panel = select('#panel-screen');
  const stage = panel.querySelector('.live-screen-stage');
  const canvas = select('#galleryScreenCanvas');
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) return;

  const width = 1120;
  const height = 514;
  const zoomSteps = [1, 1.5, 2];
  const zoomOut = select('#galleryZoomOut');
  const zoomIn = select('#galleryZoomIn');
  const zoomReset = select('#galleryZoomReset');
  const fps = select('#galleryFPS');
  const toast = stage.querySelector('.screen-toast');
  const flash = stage.querySelector('.screen-flash');
  const reactions = stage.querySelector('.screen-reactions');

  let zoom = 0;
  function changeZoom(step) {
    zoom = clamp(step, 0, zoomSteps.length - 1);
    const scale = zoomSteps[zoom];
    canvas.style.transform = zoom ? `translateY(${(scale - 1) * 1.4}%) scale(${scale})` : '';
    zoomReset.textContent = `${scale}×`;
    zoomReset.setAttribute('aria-label', `重置缩放，当前 ${scale} 倍`);
    zoomOut.setAttribute('aria-disabled', String(zoom === 0));
    zoomIn.setAttribute('aria-disabled', String(zoom === zoomSteps.length - 1));
  }
  zoomOut.addEventListener('click', () => changeZoom(zoom - 1));
  zoomIn.addEventListener('click', () => changeZoom(zoom + 1));
  zoomReset.addEventListener('click', () => changeZoom(0));

  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.getAnimations().forEach(animation => animation.cancel());
    toast.animate([{opacity: 0, transform: 'translateY(-.4cqw)'}, {opacity: 1, transform: 'none'}],
      {duration: 240, easing: spring('smooth')});
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.textContent = ''; }, 2100);
  }
  select('#galleryCapture').addEventListener('click', () => {
    flash.getAnimations().forEach(animation => animation.cancel());
    flash.animate([
      {backgroundColor: '#fff', opacity: .68},
      {backgroundColor: '#fff', opacity: 0},
    ], {duration: 270, easing: spring('smooth')});
    showToast('已演示原画截屏');
  });
  for (const button of stage.querySelectorAll('[data-screen-tip]')) {
    button.addEventListener('click', () => showToast(button.dataset.screenTip));
  }

  function releaseReaction(emoji) {
    if (reactions.childElementCount >= 8) reactions.firstElementChild.remove();
    const bubble = document.createElement('span');
    bubble.textContent = emoji;
    reactions.append(bubble);
    const animation = bubble.animate([
      {opacity: 0, transform: 'translate(0, 1cqw) scale(.72) rotate(-9deg)'},
      {opacity: 1, transform: 'translate(-.8cqw, -2.4cqw) scale(1) rotate(4deg)', offset: .22},
      {opacity: .8, transform: 'translate(.45cqw, -8cqw) scale(.94) rotate(-5deg)', offset: .72},
      {opacity: 0, transform: 'translate(1.2cqw, -11cqw) scale(.79) rotate(4deg)'},
    ], {duration: 2100, easing: 'ease-out'});
    animation.onfinish = () => bubble.remove();
  }
  const manualReactions = ['👏', '🔥', '😂', '👍'];
  const autoReactions = ['🔥', '👏', '👍'];
  let manualIndex = 0;
  let autoIndex = 0;
  select('#galleryReaction').addEventListener('click', () => {
    releaseReaction(manualReactions[manualIndex++ % manualReactions.length]);
  });

  function drawStudio(time) {
    const glass = context.createLinearGradient(340, 121, 739, 397);
    glass.addColorStop(0, '#273b44e9');
    glass.addColorStop(.53, '#101e23e8');
    glass.addColorStop(1, '#181a29ec');
    context.lineWidth = 1.2;
    canvasBox(context, 301, 135, 518, 262, 19, '#01020880');
    canvasBox(context, 301, 121, 518, 262, 19, glass, '#c2e9f070');
    canvasBox(context, 302, 122, 516, 37, [18, 18, 0, 0], '#c2e9f011');
    for (const [index, color] of ['#4adba8', '#b2a0e6', '#7ee2ee'].entries()) {
      canvasBox(context, 317 + index * 15, 137, 8, 8, 4, color);
    }
    context.textAlign = 'center';
    context.font = '600 12px system-ui, sans-serif';
    context.fillStyle = '#e3edf0';
    context.fillText('Studio — Shared workspace', 560, 145);
    context.textAlign = 'left';

    canvasBox(context, 316, 171, 220, 189, 10, '#071215b5', '#b1dbe32e');
    canvasBox(context, 547, 171, 257, 189, 10, '#0b111cb8', '#b1dbe32e');
    context.font = '600 11px system-ui, sans-serif';
    context.fillStyle = '#c7dce5';
    context.fillText('Composition', 331, 191);
    context.fillText('Motion preview', 562, 191);
    const code = [
      ['#a5b7c8', '// Chromatic study'],
      ['#b2a0e6', 'const scene = {'],
      ['#7ee2ee', '  light: "silver",'],
      ['#c6d9e3', '  depth: 0.84,'],
      ['#7ee2ee', '  motion: "fluid"'],
      ['#b2a0e6', '};'],
    ];
    context.font = '12px Consolas, monospace';
    for (const [index, [color, line]] of code.entries()) {
      context.fillStyle = '#8397aa';
      context.fillText(String(index + 1).padStart(2, '0'), 331, 219 + index * 19);
      context.fillStyle = color;
      context.fillText(line, 357, 219 + index * 19);
    }

    canvasBox(context, 561, 203, 229, 104, 5, '#071317');
    context.save();
    context.translate(561, 203);
    drawGrid(context, 229, 104, 17, '#b4e3eb19');
    context.beginPath();
    for (let x = 0; x <= 228; x += 3) {
      const y = 53 + Math.sin(x * .052 - time * 1.65) * Math.sin(x / 229 * Math.PI) * 26
        + Math.cos(x * .1 + time) * 6;
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.lineWidth = 1.8;
    context.strokeStyle = '#7ee2ee';
    context.stroke();
    context.restore();
    canvasBox(context, 562, 322, 227, 4, 2, '#9f90c24f');
    canvasBox(context, 562, 322, 112 + Math.sin(time * .64) * 39, 4, 2, '#7ee2ee');
    for (const [index, color] of ['#17333b', '#31838c', '#7ee2ee', '#b2a0e6'].entries()) {
      canvasBox(context, 562 + index * 15, 336, 10, 10, 3, color);
    }
    context.font = '10px Consolas, monospace';
    context.fillStyle = '#a5b7c8';
    context.fillText('PREVIEW  /  1920 × 1080', 656, 344);
  }

  function draw(time) {
    context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    const ambient = context.createRadialGradient(560, 259, 40, 560, 259, 535);
    ambient.addColorStop(0, '#14262d');
    ambient.addColorStop(.62, '#0a1016');
    ambient.addColorStop(1, '#000');
    context.fillStyle = ambient;
    context.fillRect(0, 0, width, height);
    drawRibbon(context, time, 2.5, peacockMetal);
    drawRibbon(context, time, 0, frostMetal);
    drawStudio(time);

    const cycle = time % 8.4;
    const returning = cycle >= 4.2;
    const progress = (cycle % 4.2) / 4.2;
    const eased = progress * progress * (3 - 2 * progress);
    const u = returning ? 1 - eased : eased;
    const v = 1 - u;
    const x = v ** 3 * 455 + 3 * v * v * u * 505 + 3 * v * u * u * 726 + u ** 3 * 738;
    const bend = returning ? 1 : -1;
    const y = v ** 3 * 244 + 3 * v * v * u * (244 + bend * 83)
      + 3 * v * u * u * (283 + bend * 66) + u ** 3 * 283;
    const clickAge = cycle - 4.2;
    if (clickAge >= 0 && clickAge < .7) {
      context.beginPath();
      context.arc(738, 283, 5 + clickAge * 50, 0, 2 * Math.PI);
      context.strokeStyle = `rgba(126, 226, 238, ${.8 * (1 - clickAge / .7)})`;
      context.stroke();
    }
    drawCursor(context, x, y, 20);
  }

  let frame = 0;
  let time = 0;
  let previous = 0;
  let deadline = 0;
  let sampleStart = 0;
  let sampleFrames = 0;
  let nextReaction = 4.5;
  let visible = !('IntersectionObserver' in window);
  let running = false;

  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const {clientWidth, clientHeight} = stage;
    if (!clientWidth || !clientHeight) return;
    const pixelWidth = Math.round(clientWidth * ratio);
    const pixelHeight = Math.round(clientHeight * ratio);
    if (canvas.width === pixelWidth && canvas.height === pixelHeight) return;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    draw(time);
  }
  function tick(now) {
    if (!running) return;
    const interval = 1000 / 60;
    if (now + .75 >= deadline) {
      if (previous) time += Math.min(.08, (now - previous) / 1000);
      previous = now;
      deadline = deadline && now - deadline < interval ? deadline + interval : now + interval;
      draw(time);
      sampleFrames++;
      if (now - sampleStart >= 2000) {
        const measured = Math.round(sampleFrames * 1000 / (now - sampleStart));
        fps.textContent = String(clamp(measured, 1, 60));
        sampleStart = now;
        sampleFrames = 0;
      }
      if (time >= nextReaction) {
        releaseReaction(autoReactions[autoIndex++ % autoReactions.length]);
        nextReaction += 4.5;
      }
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    const shouldRun = visible && !panel.hidden && !document.hidden;
    if (shouldRun === running) return;
    running = shouldRun;
    stage.toggleAttribute('data-paused', !running);
    if (running) {
      resize();
      previous = deadline = sampleFrames = 0;
      sampleStart = performance.now();
      frame = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frame);
      reactions.replaceChildren();
    }
  }

  stage.hidden = false;
  stage.toggleAttribute('data-paused', !visible);
  resize();
  new ResizeObserver(resize).observe(stage);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    }).observe(stage);
  }
  new MutationObserver(sync).observe(panel, {attributes: true, attributeFilter: ['hidden']});
  document.addEventListener('visibilitychange', sync);
  sync();
}
setupGalleryScreen();

if (CSS.supports('selector(details::details-content)')) {
  for (const details of document.querySelectorAll('.faq details')) {
    const summary = details.querySelector('summary');
    const answer = details.querySelector('.faq-answer');
    let animation;

    function reset() {
      animation?.cancel();
      animation = null;
      delete details.dataset.closing;
      answer.inert = false;
    }

    summary.addEventListener('click', event => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const opening = !details.open;
      const from = details.open || animation ? answer.getBoundingClientRect().height : 0;
      const opacity = animation ? getComputedStyle(answer).opacity : opening ? 0 : 1;
      reset();
      details.dataset.closing = String(!opening);
      answer.inert = !opening;
      details.open = opening;
      const to = opening ? answer.getBoundingClientRect().height : 0;
      animation = answer.animate([
        {height: `${from}px`, opacity, overflow: 'clip'},
        {height: `${to}px`, opacity: opening ? 1 : 0, overflow: 'clip'},
      ], {duration: opening ? 340 : 240, easing: spring('smooth'), fill: 'both'});
      animation.onfinish = reset;
    });
  }
}
