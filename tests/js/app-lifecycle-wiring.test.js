import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('local websocket disconnect is wired to media and room cleanup', async () => {
  const app = await readFile(new URL('../../internal/web/assets/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ bindLocalConnectionLifecycle \} from '\.\/connection-lifecycle\.js'/);
  assert.match(app, /bindLocalConnectionLifecycle\(client, media, \(\) => \{/);
  assert.match(app, /ui\.roleChooser\.hidden = false/);
  assert.match(app, /ui\.roomPanel\.hidden = true/);
  assert.match(app, /catch \(error\) \{\s*if \(!client\.reconnectWanted\) return;/, 'in-flight reconnect does not overwrite local-disconnect cleanup');
});

test('page lease starts from the initial role page before any local websocket connection', async () => {
  const app = await readFile(new URL('../../internal/web/assets/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ PageLease \} from '\.\/page-lease\.js'/);
  assert.match(app, /client\.loadLocalControl\(\)\.then\(\(bootstrap\) => \{\s*pageLease = new PageLease\(\{ token: bootstrap\.localControlToken \}\);\s*void pageLease\.start\(\);/);
  assert.ok(app.indexOf('pageLease.start()') < app.indexOf("$('#choose-viewer').addEventListener"), 'lease starts independently of choosing a role');
});
