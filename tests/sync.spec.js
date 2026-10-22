import { test, expect } from '@playwright/test';
import { freshIp } from './helpers.js';

// Each context = an isolated browser profile (own IndexedDB/localStorage), like a different machine.
async function openClient(browser, baseURL) {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.setExtraHTTPHeaders({ 'CF-Connecting-IP': freshIp() });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()} @ ${m.location().url}`); });
  await page.goto(baseURL);
  return { page, problems };
}

async function connect(page, code) {
  await page.fill('#syncInput', code);
  await page.click('#syncConnect');
  await expect(page.locator('#syncStatus')).toContainText('realtime', { timeout: 20_000 });
}

async function save(page, title, content) {
  await page.fill('#title', title);
  await page.fill('#content', content);
  await page.click('#form button.primary');
}

const titles = (page) => page.locator('.card[data-id] .note-title');

test('two browsers share one list in realtime (add, edit, delete, concurrent adds)', async ({ browser, baseURL }) => {
  const A = await openClient(browser, baseURL);
  const B = await openClient(browser, baseURL);

  await save(A.page, 'before-connect', 'dhcp relay 10.0.0.1 / 10.0.0.2');
  await A.page.click('#syncGen');
  const code = await A.page.inputValue('#syncInput');
  expect(code.replace(/-/g, '')).toHaveLength(20);
  await connect(A.page, code);
  await expect(A.page.locator('.card[data-id] .meta')).toContainText('đã đồng bộ');

  await connect(B.page, code.toLowerCase().replace(/-/g, '')); // case/dash-insensitive
  await expect(titles(B.page)).toHaveText(['before-connect']);

  // realtime push: no manual refresh
  await save(B.page, 'from-B', 'dns 10.1.1.1 / 10.1.1.2');
  await expect(titles(A.page)).toContainText(['from-B'], { timeout: 10_000 });

  // edit propagates
  await A.page.locator('.card[data-id]', { hasText: 'from-B' }).locator('button[data-act=edit]').click();
  await A.page.fill('#content', 'dns 10.1.1.1 / 10.1.1.2 (edited by A)');
  await A.page.click('#form button.primary');
  await expect(B.page.locator('.card[data-id] pre', { hasText: 'edited by A' })).toBeVisible({ timeout: 10_000 });

  // delete propagates immediately (strongly consistent list, no grace period)
  await A.page.locator('.card[data-id]', { hasText: 'before-connect' }).locator('button[data-act=del]').click();
  await expect(titles(B.page)).toHaveText(['from-B'], { timeout: 10_000 });

  // concurrent saves on both sides: nothing lost anywhere
  await Promise.all([save(A.page, 'race-A', 'a'), save(B.page, 'race-B', 'b')]);
  for (const c of [A, B]) {
    await expect.poll(async () => (await titles(c.page).allTextContents()).sort(), { timeout: 15_000 })
      .toEqual(['from-B', 'race-A', 'race-B']);
  }

  // reload keeps the connection and the data
  await B.page.reload();
  await expect(B.page.locator('#syncStatus')).toContainText('realtime', { timeout: 20_000 });
  await expect.poll(async () => (await titles(B.page).allTextContents()).sort()).toEqual(['from-B', 'race-A', 'race-B']);

  expect(A.problems).toEqual([]);
  expect(B.problems).toEqual([]);
});

test('wrong code sees nothing; connect link joins the room', async ({ browser, baseURL }) => {
  const A = await openClient(browser, baseURL);
  await A.page.click('#syncGen');
  await connect(A.page, await A.page.inputValue('#syncInput'));
  await save(A.page, 'secret', 'x');
  await expect(A.page.locator('.card[data-id] .meta')).toContainText('đã đồng bộ');

  const C = await openClient(browser, baseURL);
  await connect(C.page, 'WRONG-CODE-0000-0000-0000');
  await expect(C.page.locator('.card[data-id]')).toHaveCount(0);

  await A.page.click('button[data-sync=link]');
  const link = await A.page.evaluate(() => navigator.clipboard.readText());
  const D = await openClient(browser, baseURL);
  await D.page.goto(link);
  await expect(titles(D.page)).toHaveText(['secret'], { timeout: 20_000 });
  expect(await D.page.evaluate(() => location.hash)).toBe(''); // code removed from address bar
  expect([...A.problems, ...C.problems, ...D.problems]).toEqual([]);
});

test('short custom code is rejected; share link works across browsers; embed link is off', async ({ browser, baseURL }) => {
  const A = await openClient(browser, baseURL);
  await A.page.fill('#syncInput', 'ABC123');
  await A.page.click('#syncConnect');
  await expect(A.page.locator('#toast')).toContainText('tối thiểu 12');

  await save(A.page, 'to-share', 'config snippet');
  await expect(A.page.locator('button[data-act=embed]')).toHaveCount(0);
  await A.page.click('button[data-act=share]');
  const url = await A.page.inputValue('.card[data-id] .share-box input');
  expect(url).toMatch(/#s=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);

  const B = await openClient(browser, baseURL);
  await B.page.goto(url);
  await expect(B.page.locator('#sharedPre')).toHaveText('config snippet', { timeout: 15_000 });
  expect([...A.problems, ...B.problems]).toEqual([]);
});
