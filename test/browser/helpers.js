'use strict';
// Autor: Mateusz Bartoszewicz
// Narzędzia testów w przeglądarce (Playwright + Chromium). Testy są opcjonalne: bez zainstalowanego Playwrighta zostają pominięte.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../scripts/build');
const { bootWeb } = require('../web-helpers');
const { ID } = require('../helpers');

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }

const FIXTURES = path.join(__dirname, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Buduje stronę do katalogu tymczasowego razem z fałszywym hostem Discorda (host.html, host.js).
async function buildSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-site-'));
  const outdir = path.join(dir, 'public');
  await build({ outdir, quiet: true });
  for (const f of ['host.html', 'host.js', 'host.css']) fs.copyFileSync(path.join(FIXTURES, f), path.join(outdir, f));
  return { dir, outdir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Strona zalogowana jako dana osoba: sesja trafia do ciasteczka, jak po prawdziwym logowaniu w przeglądarce.
async function openAs(t, browser, userId, { device = null, viewport = { width: 1280, height: 760 }, colorScheme = 'light', path: url = '/' } = {}) {
  const ctx = await browser.newContext(device ? { ...device, colorScheme } : { viewport, colorScheme });
  const session = await t.login(userId);
  await ctx.addCookies([{ name: 'gb_sess', value: session, url: t.base }]);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(text)) problems.push(`csp: ${text}`);
  });
  page.on('dialog', async (d) => { problems.push(`dialog: ${d.message()}`); await d.dismiss(); });
  await page.goto(`${t.base}${url}`);
  return { ctx, page, problems, session };
}

const colSel = (status) => `.col[data-status="${status}"]`;
const cardSel = (name, status) => `${status ? colSel(status) : ''} .card:has-text("${name}")`;

async function centerOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element nie jest widoczny');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

// Przeciągnięcie myszą: przesuwa kursor w wielu krokach, żeby zdarzenia wyglądały jak od człowieka.
async function mouseDrag(page, from, to, { steps = 14, release = true } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps });
  await page.waitForTimeout(80); // pętla przeciągania odświeża podświetlenie co klatkę
  if (release) await page.mouse.up();
}

// Dotyk przez CDP: prawdziwe zdarzenia dotykowe przeglądarki (a nie syntetyczne zdarzenia z JavaScriptu).
async function touchDrag(cdp, page, from, to, { hold = 0, steps = 12, release = true } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  if (hold) await page.waitForTimeout(hold);
  for (let i = 1; i <= steps; i += 1) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(80);
  if (release) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

module.exports = { playwright, buildSite, openAs, colSel, cardSel, centerOf, mouseDrag, touchDrag, bootWeb, ID, sleep };
