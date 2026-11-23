import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {bindViewerTools, canPictureInPicture, clampVideoView, downloadVideoFrame} from '../../internal/web/assets/viewer-tools.js';

const geometry = {width: 800, height: 600, videoWidth: 1920, videoHeight: 1080};
test('zoom stays in 1× to 3× and pan clamps to the letterboxed image', () => {
  assert.deepEqual(clampVideoView({scale: 4, x: 1000, y: -1000}, geometry), {scale: 3, x: 800, y: -375});
  assert.deepEqual(clampVideoView({scale: 1.2, x: -1000, y: 500}, geometry), {scale: 1.2, x: -80, y: 0});
  assert.deepEqual(clampVideoView({scale: .5, x: 160, y: -10}, geometry), {scale: 1, x: 0, y: 0});
});

function fixture() {
  const {document: documentRef, Event} = parseHTML('<div id="stage"><video></video></div><button id="pip"><span class="button-label"></span></button><button id="capture"></button><button id="smaller"></button><button id="reset"></button><button id="larger"></button>');
  const stage = documentRef.querySelector('#stage'), video = stage.querySelector('video');
  const buttons = Object.fromEntries(['pip', 'capture', 'smaller', 'reset', 'larger'].map(id => [id, documentRef.getElementById(id)]));
  const notices = [];
  let enter = 0, exit = 0;
  Object.assign(video, {clientWidth: 800, clientHeight: 600, videoWidth: 1920, videoHeight: 1080, readyState: 2});
  Object.assign(documentRef, {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    async exitPictureInPicture() {
      exit++;
      this.pictureInPictureElement = null;
      video.dispatchEvent(new Event('leavepictureinpicture'));
    },
  });
  video.requestPictureInPicture = async () => {
    enter++;
    documentRef.pictureInPictureElement = video;
    video.dispatchEvent(new Event('enterpictureinpicture'));
  };
  const tools = bindViewerTools({documentRef, stage, video, ...buttons, onNotice: text => notices.push(text)});
  return {documentRef, video, tools, ...buttons, notices, Event, calls: () => [enter, exit]};
}

test('zoom reset and presenter changes clear the original video transform', () => {
  const {tools, video, larger, reset} = fixture();
  tools.setPresentation('first', true);
  for (let i = 0; i < 12; i++) larger.click();
  assert.equal(reset.textContent, '3×');
  assert.equal(tools.canDoubleClick(), false);
  reset.click();
  assert.equal(reset.textContent, '1×');
  assert.equal(tools.canDoubleClick(), true);
  larger.click();
  tools.setPresentation('first', true);
  assert.equal(reset.textContent, '1.25×');
  tools.setPresentation('second', true);
  assert.equal(reset.textContent, '1×');
  assert.ok(!video.style.transform);
});

test('PiP enters in the click, follows browser events and leaves on stop', async () => {
  const {documentRef, video, tools, pip, Event, calls} = fixture();
  assert.equal(canPictureInPicture(documentRef, video), true);
  assert.equal(canPictureInPicture(documentRef, {}), false);
  tools.setPresentation('first', true);
  video.disablePictureInPicture = true;
  video.dispatchEvent(new Event('resize'));
  assert.equal(pip.getAttribute('aria-disabled'), 'true');
  assert.match(pip.title, /不支持/);
  pip.click();
  assert.deepEqual(calls(), [0, 0]);
  video.disablePictureInPicture = false;
  video.dispatchEvent(new Event('resize'));
  pip.click();
  assert.deepEqual(calls(), [1, 0]);
  assert.equal(pip.getAttribute('aria-pressed'), 'true');
  assert.match(pip.textContent, /退出画中画/);
  await Promise.resolve();
  await documentRef.exitPictureInPicture();
  assert.equal(pip.getAttribute('aria-pressed'), 'false');
  pip.click();
  tools.setPresentation('', false);
  await Promise.resolve();
  assert.deepEqual(calls(), [2, 2]);
  assert.equal(pip.getAttribute('aria-pressed'), 'false');
  assert.equal(pip.getAttribute('aria-disabled'), 'true');
});

test('pending PiP closes on presenter change and activation rejection offers a retry', async () => {
  const {documentRef, video, tools, pip, Event, calls, notices} = fixture();
  tools.setPresentation('first', true);
  let finish;
  video.requestPictureInPicture = () => new Promise(resolve => {
    finish = () => {
      documentRef.pictureInPictureElement = video;
      video.dispatchEvent(new Event('enterpictureinpicture'));
      resolve();
    };
  });
  pip.click();
  await assert.rejects(tools.beforeFullscreen(), /再点一次/);
  tools.setPresentation('second', true);
  finish();
  await new Promise(setImmediate);
  assert.deepEqual(calls(), [0, 1]);
  assert.equal(pip.getAttribute('aria-pressed'), 'false');
  video.requestPictureInPicture = async () => { throw new DOMException('activation expired', 'NotAllowedError'); };
  pip.click();
  await new Promise(setImmediate);
  assert.match(notices.at(-1), /再点一次/);
});

test('screenshot needs a valid frame and exports the original resolution as PNG', async () => {
  const {tools, video, capture, Event} = fixture();
  tools.setPresentation('first', true);
  video.videoWidth = 0;
  video.dispatchEvent(new Event('resize'));
  assert.equal(capture.getAttribute('aria-disabled'), 'true');
  const calls = [];
  const image = new Blob(['png'], {type: 'image/png'});
  const canvas = {
    getContext(type) { assert.equal(type, '2d'); return {drawImage: (...args) => calls.push(args)}; },
    toBlob(callback, type) { assert.equal(type, 'image/png'); callback(image); },
  };
  const anchor = {click() { calls.push(this.download); }};
  const documentRef = {createElement: name => name === 'canvas' ? canvas : anchor};
  const url = {createObjectURL(blob) { assert.equal(blob, image); return 'blob:screenshot'; }, revokeObjectURL() {}};
  const date = new Date(2026, 10, 23, 9, 4, 7);
  assert.equal(await downloadVideoFrame({documentRef, video, url, date}), false);
  video.videoWidth = 1920;
  video.dispatchEvent(new Event('resize'));
  video.style.transform = 'translate(100px, 5px) scale(3)';
  assert.equal(capture.getAttribute('aria-disabled'), 'false');
  assert.equal(await downloadVideoFrame({documentRef, video, url, date}), true);
  assert.deepEqual([canvas.width, canvas.height], [1920, 1080]);
  assert.deepEqual(calls, [[video, 0, 0, 1920, 1080], 'LAN分享-20261123-090407.png']);
  assert.equal(anchor.href, 'blob:screenshot');
});
