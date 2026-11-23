import assert from 'node:assert/strict';

export async function checkLiquidGlass(page, selectors, imageSelector) {
  const session = await page.context().newCDPSession(page);
  try {
    for (const preference of ['prefers-contrast', 'prefers-reduced-transparency']) {
      const value = preference === 'prefers-contrast' ? 'more' : 'reduce';
      const query = '(' + preference + ': ' + value + ')';
      await session.send('Emulation.setEmulatedMedia', {features: [
        {name: 'forced-colors', value: 'none'},
        {name: 'prefers-reduced-motion', value: 'reduce'},
        {name: 'prefers-contrast', value: 'no-preference'},
        {name: 'prefers-reduced-transparency', value: 'no-preference'},
      ].map(feature => feature.name === preference ? {name: preference, value} : feature)});
      assert.equal(await page.evaluate(query => matchMedia(query).matches &&
        matchMedia('(forced-colors: none)').matches, query), true, 'emulated ' + query);
      for (const selector of selectors) {
        const filter = await page.locator(selector).evaluate(node => getComputedStyle(node).backdropFilter);
        assert.match(filter, /blur\(/, selector + ' keeps blur with ' + query);
      }
      if (imageSelector) assert.equal(await page.locator(imageSelector).isVisible(), true, imageSelector + ' stays visible with ' + query);
    }
  } finally {
    await session.send('Emulation.setEmulatedMedia', {features: []});
    await session.detach();
  }
}
