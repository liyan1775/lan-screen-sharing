// An original example document shared as the demo's synthetic display input.
// This function is serialized into a fresh browser context by the capture script.
export function drawDemoDisplay(ctx, width, height, elapsed, participant) {
  const outbound = participant === 'host';
  const accent = outbound ? '#bdec9c' : '#ffcf91';
  const route = outbound
    ? [[746, 628], [843, 555], [917, 586], [1022, 476], [967, 380], [1101, 281], [1213, 318], [1325, 232], [1430, 294]]
    : [[1430, 294], [1336, 387], [1407, 496], [1257, 532], [1160, 638], [1045, 616], [950, 689], [860, 638], [746, 628]];

  function text(content, x, y, size, fill, weight = 400) {
    ctx.font = `${weight} ${size}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = fill;
    ctx.fillText(content, x, y);
  }

  function dot(x, y, radius, fill) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.save();
  ctx.setTransform(width / 1600, 0, 0, height / 900, 0, 0);
  ctx.fillStyle = '#102723';
  ctx.fillRect(0, 0, 1600, 900);
  text('路线讨论  /  演示稿', 88, 112, 28, '#a6c6b7', 600);
  text('周末骑行', 83, 302, 103, '#f3f7ef', 700);
  text(outbound ? '去程路线' : '返程路线', 83, 442, 103, accent, 700);
  text(outbound ? '从河边出发，在观景台集合。' : '从观景台出发，沿南岸返回。', 89, 535, 29, '#c9ded2');
  ctx.fillStyle = '#42675b';
  ctx.fillRect(89, 656, 475, 2);
  text('路线示意 · 自制演示素材', 89, 725, 25, '#a6c6b7');

  ctx.beginPath();
  ctx.roundRect(653, 85, 861, 730, 32);
  ctx.clip();
  ctx.fillStyle = '#193d36';
  ctx.fillRect(653, 85, 861, 730);
  ctx.strokeStyle = '#32554a';
  ctx.lineWidth = 1;
  for (let x = 686; x < 1514; x += 36) {
    ctx.beginPath(); ctx.moveTo(x, 85); ctx.lineTo(x, 815); ctx.stroke();
  }
  for (let y = 117; y < 815; y += 36) {
    ctx.beginPath(); ctx.moveTo(653, y); ctx.lineTo(1514, y); ctx.stroke();
  }
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(609, 490);
  ctx.bezierCurveTo(822, 360, 842, 727, 1095, 543);
  ctx.bezierCurveTo(1246, 430, 1338, 262, 1545, 380);
  ctx.strokeStyle = '#315d6d';
  ctx.lineWidth = 60;
  ctx.stroke();
  ctx.strokeStyle = '#447884';
  ctx.lineWidth = 2;
  ctx.stroke();
  text('南岸', 1210, 753, 29, '#adcec1');
  text('河畔公园', 710, 242, 29, '#adcec1');

  ctx.beginPath();
  for (const [index, [x, y]] of route.entries()) {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0e2c27';
  ctx.lineWidth = 18;
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 8;
  ctx.stroke();
  for (const [x, y] of [route[0], route.at(-1)]) {
    dot(x, y, 14, '#102723');
    dot(x, y, 8, accent);
  }
  const position = (elapsed / 940) % (route.length - 1);
  const [x1, y1] = route[Math.floor(position)];
  const [x2, y2] = route[Math.floor(position) + 1];
  const x = x1 + (x2 - x1) * (position % 1);
  const y = y1 + (y2 - y1) * (position % 1);
  dot(x, y, 22, '#ffffff38');
  dot(x, y, 10, '#fff');
  ctx.restore();
}
