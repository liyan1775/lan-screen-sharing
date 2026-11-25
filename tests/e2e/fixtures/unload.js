import assert from 'node:assert/strict';

async function checkUnload(page, action, expected, label) {
  const dialogs = [];
  const handleDialog = dialog => {
    dialogs.push({ type: dialog.type(), handled: dialog.accept() });
  };
  page.on('dialog', handleDialog);
  try {
    // A real pointer gesture supplies the sticky activation Edge requires for
    // beforeunload. Use an inert corner rather than a room action.
    await page.bringToFront();
    await page.mouse.click(1, 1);
    await action();
    await Promise.all(dialogs.map(dialog => dialog.handled));
    assert.deepEqual(dialogs.map(dialog => dialog.type), expected ? ['beforeunload'] : [], label);
  } finally {
    page.off('dialog', handleDialog);
  }
}

export function reloadWithUnloadCheck(page, expected) {
  return checkUnload(page, async () => {
    const response = await page.reload({ timeout: 15_000 });
    assert.ok(response?.ok(), 'the replacement document must load after reload');
  }, expected, 'Edge beforeunload dialogs during reload');
}

export function closeEntryWithoutUnloadDialog(page) {
  // Normal Playwright teardown skips beforeunload entirely.
  return checkUnload(page, () => Promise.all([
    page.waitForEvent('close', { timeout: 15_000 }),
    page.close({ runBeforeUnload: true }),
  ]), false, 'Edge beforeunload dialogs when closing the entry page');
}
