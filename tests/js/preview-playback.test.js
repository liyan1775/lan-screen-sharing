import test from 'node:test';
import assert from 'node:assert/strict';
import { setPreviewStream } from '../../internal/web/assets/preview-playback.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeVideo() {
  const pending = [];
  return {
    srcObject: null,
    pending,
    play() {
      const playback = deferred();
      pending.push(playback);
      return playback.promise;
    },
  };
}

test('a rejected play promise from a cleared preview does not surface a stale warning', async () => {
  assert.equal(typeof setPreviewStream, 'function', 'production preview playback helper is wired');
  const video = fakeVideo();
  const warnings = [];
  const stream = {};
  setPreviewStream(video, stream, () => warnings.push('blocked'));
  setPreviewStream(video, null, () => warnings.push('blocked'));
  video.pending[0].reject(new Error('playback ended after stream cleanup'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(warnings, []);
  assert.equal(video.srcObject, null);
});

test('a rejected play promise from a replaced preview does not mask the new source', async () => {
  assert.equal(typeof setPreviewStream, 'function', 'production preview playback helper is wired');
  const video = fakeVideo();
  const warnings = [];
  const oldStream = {};
  const currentStream = {};
  setPreviewStream(video, oldStream, () => warnings.push('blocked'));
  setPreviewStream(video, currentStream, () => warnings.push('blocked'));
  video.pending[0].reject(new Error('old stream stopped'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(warnings, []);
  assert.equal(video.srcObject, currentStream);
});

test('a rejected play promise from the current preview still reports autoplay blocking', async () => {
  assert.equal(typeof setPreviewStream, 'function', 'production preview playback helper is wired');
  const video = fakeVideo();
  const warnings = [];
  const currentStream = {};
  setPreviewStream(video, currentStream, () => warnings.push('blocked'));
  video.pending[0].reject(new Error('current autoplay denied'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(warnings, ['blocked']);
});

test('clearing a preview does not call play', () => {
  assert.equal(typeof setPreviewStream, 'function', 'production preview playback helper is wired');
  const video = fakeVideo();
  setPreviewStream(video, null, () => assert.fail('empty source must not show an autoplay warning'));
  assert.equal(video.pending.length, 0);
  assert.equal(video.srcObject, null);
});

test('a room state refresh does not reassign or restart the current video source', () => {
  const video = fakeVideo(), stream = {};
  setPreviewStream(video, stream);
  setPreviewStream(video, stream);
  assert.equal(video.pending.length, 1, 'the same stream keeps one uninterrupted playback');
});
