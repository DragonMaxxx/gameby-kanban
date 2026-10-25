'use strict';
// Autor: Mateusz Bartoszewicz
// Logowanie w prawdziwej przeglądarce: pełna ścieżka OAuth2 (Discord zastąpiony przechwyceniem przekierowania) oraz Activity na
// prawdziwym Embedded App SDK 2.3.1, które rozmawia z udawanym klientem Discorda (test/browser/fixtures/host.js).
// Nie sprawdza to prawdziwego Discorda: testuje naszą stronę i zgodność z protokołem opisanym przez schematy SDK.
const test = require('node:test');
const assert = require('node:assert/strict');
const { playwright, buildSite, centerOf, mouseDrag, bootWeb, ID } = require('./helpers');
const { tagId } = require('../fake-discord');
const { taskIn, waitFor } = require('../web-helpers');

const SKIP = playwright ? false : 'pakiet playwright nie jest zainstalowany';
let site;
let browser;

test.before(async () => {
  if (!playwright) return;
  site = await buildSite();
  browser = await playwright.chromium.launch();
});
test.after(async () => {
  if (browser) await browser.close();
  if (site) site.cleanup();
});

const withSite = async (opts, fn) => {
  const t = await bootWeb({ localUrl: true, publicDir: site.outdir, ...opts });
  try { return await fn(t); } finally { await t.close(); }
};

const cspProblems = (page, sink) => {
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) sink.push(m.text()); });
  page.on('pageerror', (e) => sink.push(`pageerror: ${e.message}`));
};

// ---------------------------------------------------------------- przeglądarka
test('przeglądarka: ekran logowania, logowanie kontem Discorda, zmiana z ciasteczkiem sesji i wylogowanie', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  const problems = [];
  cspProblems(page, problems);
  try {
    t.oauth.loginAs = ID.autor;
    t.oauth.consentGiven = false; // pierwsze logowanie: prompt=none kończy się consent_required, strona ponawia z oknem zgody
    await page.goto(`${t.base}/`);
    await page.waitForSelector('button:has-text("Zaloguj przez Discord")');
    assert.equal(await page.locator('.card').count(), 0, 'bez logowania nie widać żadnych zadań');
    await page.locator('button:has-text("Zaloguj przez Discord")').click();
    await page.waitForSelector('.card');
    assert.equal(new URL(page.url()).pathname, '/');
    assert.deepEqual(t.oauth.authorizeRequests.map((r) => r.prompt || null), ['none', null], 'najpierw bez okna zgody, potem z oknem');
    const cookies = await ctx.cookies(t.base);
    const sess = cookies.find((c) => c.name === 'gb_sess');
    assert.ok(sess && sess.httpOnly && sess.sameSite === 'Lax', 'ciasteczko sesji: HttpOnly, SameSite=Lax');
    assert.equal(await page.evaluate(() => document.cookie), '', 'skrypt strony nie widzi ciasteczka sesji');
    assert.equal(cookies.some((c) => c.name === 'gb_oauth' && c.value), false, 'ciasteczko stanu zostało wyczyszczone');
    await page.waitForFunction(() => document.querySelector('.user-chip').textContent.includes('u1001'));
    assert.ok(await waitFor(() => t.oauth.revoked.includes(`tok-${ID.autor}`)), 'token użytkownika odwołany zaraz po zalogowaniu');

    // zmiana z poziomu strony z ciasteczkiem (nagłówek Origin musi się zgadzać z PUBLIC_URL)
    await page.locator('.card', { hasText: 'Pomysł C' }).click();
    await page.locator('.status-btn', { hasText: 'W pisaniu' }).click();
    await page.waitForSelector('.col[data-status="W pisaniu"] .card:has-text("Pomysł C")');
    const board = (await t.call(await t.login(ID.autor), 'GET', '/api/board')).json;
    assert.ok(t.fake.thread(taskIn({ json: board }, 'Pomysł C').id).applied_tags.includes(tagId('W pisaniu')));

    // wylogowanie (najpierw zamykamy okno zadania, które zasłania pasek u góry)
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sheet', { state: 'detached' });
    await page.locator('.link-btn', { hasText: 'Wyloguj' }).click();
    await page.waitForSelector('button:has-text("Zaloguj przez Discord")');
    assert.equal((await ctx.cookies(t.base)).some((c) => c.name === 'gb_sess' && c.value), false);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('przeglądarka: konto bez roli Redakcja i podmieniony stan logowania kończą się czytelnym komunikatem', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  try {
    t.oauth.loginAs = ID.obcy;
    await page.goto(`${t.base}/`);
    await page.locator('button:has-text("Zaloguj przez Discord")').click();
    await page.waitForSelector('.center-card .error');
    assert.match(await page.locator('.center-card .error').innerText(), /nie ma dostępu do forum redakcji/);
    assert.equal(new URL(page.url()).search, '', 'parametr błędu znika z adresu');
    assert.equal(await page.locator('.card').count(), 0);
    t.oauth.loginAs = ID.autor;
    t.oauth.tamperState = true;
    await page.goto(`${t.base}/`);
    await page.locator('button:has-text("Zaloguj przez Discord")').click();
    await page.waitForSelector('.center-card .error:has-text("wygasło albo zostało przerwane")');
    assert.equal(await page.locator('.card').count(), 0, 'sfałszowany stan (CSRF logowania) nie loguje');
    assert.equal(t.site.sessions.size, 0, 'żadna sesja nie powstała');
  } finally { await ctx.close(); }
}));

test('przeglądarka: przekroczenie limitu prób logowania pokazuje komunikat o limicie, a nie ogólny błąd', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  try {
    // /auth/* ma limit 40 prób na minutę z jednego adresu; zużywamy go prostymi zapytaniami, bez przeglądarki.
    for (let i = 0; i < 40; i += 1) await fetch(`${t.base}/auth/login`, { redirect: 'manual' });
    t.oauth.loginAs = ID.autor;
    await page.goto(`${t.base}/`);
    await page.locator('button:has-text("Zaloguj przez Discord")').click();
    await page.waitForSelector('.center-card .error:has-text("Za dużo prób logowania")');
    assert.equal(await page.locator('.card').count(), 0);
    assert.equal(t.site.sessions.size, 0);
  } finally { await ctx.close(); }
}));

// ---------------------------------------------------------------- Activity na prawdziwym SDK
const hostCalls = (page) => page.evaluate(() => window.__calls.map((c) => ({ cmd: c.cmd, args: c.args })));

test('Activity: prawdziwe SDK przechodzi uzgadnianie, logowanie i pracę na tablicy przez /.proxy z nagłówkiem Authorization', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  const problems = [];
  cspProblems(page, problems);
  const apiRequests = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) apiRequests.push({ url: r.url(), auth: r.headers().authorization || null, cookie: r.headers().cookie || null, method: r.method() }); });
  const popups = [];
  page.on('popup', (p) => popups.push(p.url()));
  try {
    await page.goto(`${t.base}/host.html?code=code-${ID.szef}`);
    const frame = page.frameLocator('#f');
    await frame.locator('.card').first().waitFor({ timeout: 10000 });

    const calls = await hostCalls(page);
    assert.deepEqual(calls.map((c) => c.cmd).slice(0, 3), ['HANDSHAKE', 'AUTHORIZE', 'AUTHENTICATE']);
    assert.equal(calls[0].args.client_id, ID.app);
    assert.equal(calls[0].args.frame_id, 'frame-1');
    assert.deepEqual(calls[1].args, { client_id: ID.app, response_type: 'code', state: '', prompt: 'none', scope: ['identify', 'guilds.members.read'] });
    assert.equal(calls[2].args.access_token, `tok-${ID.szef}`, 'SDK dostaje token do potwierdzenia sesji w kliencie Discorda');
    assert.equal(calls.some((c) => c.cmd === 'CAPTURE_LOG'), false, 'konsola strony nie jest wysyłana do Discorda');

    for (const r of apiRequests) {
      assert.ok(r.url.startsWith(`${t.base}/.proxy/api/`), `zapytanie przez /.proxy: ${r.url}`);
      assert.equal(r.cookie, null, 'Activity nie używa ciasteczek');
    }
    const boardReq = apiRequests.find((r) => r.url.endsWith('/api/board'));
    assert.match(boardReq.auth, /^Bearer [A-Za-z0-9_-]{40,}$/);
    assert.equal(apiRequests.find((r) => r.url.endsWith('/api/token')).auth, null, 'przy logowaniu nie ma jeszcze sesji');
    assert.equal(await frame.locator('.user-chip .link-btn').count(), 0, 'w Activity nie ma przycisku Wyloguj');

    // przeciąganie w ramce
    const ids = taskIn(await t.call(await t.login(ID.szef), 'GET', '/api/board'), 'Pomysł C').id;
    const from = await centerOf(frame.locator('.col[data-status="Pomysł"] .card', { hasText: 'Pomysł C' }));
    const to = await centerOf(frame.locator('.col[data-status="W pisaniu"] .col-list'));
    await mouseDrag(page, from, to);
    await frame.locator('.col[data-status="W pisaniu"] .card', { hasText: 'Pomysł C' }).waitFor();
    await page.waitForTimeout(150);
    assert.ok(t.fake.thread(ids).applied_tags.includes(tagId('W pisaniu')), 'zmiana z Activity trafiła do Discorda');

    // link do posta idzie przez SDK (openExternalLink), a nie przez nową kartę
    await frame.locator('.card', { hasText: 'Recenzja A' }).click();
    await frame.locator('.sheet a:has-text("Otwórz post")').click();
    await page.waitForFunction(() => window.__calls.some((c) => c.cmd === 'OPEN_EXTERNAL_LINK'));
    const open = (await hostCalls(page)).find((c) => c.cmd === 'OPEN_EXTERNAL_LINK');
    assert.match(open.args.url, /^https:\/\/discord\.com\/channels\/\d+\/\d+$/);
    assert.deepEqual(popups, [], 'nie otwarto nowej karty');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('Activity: po utracie sesji (np. restarcie bota) strona loguje się ponownie bez udziału użytkownika', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${t.base}/host.html?code=code-${ID.szef}`);
    const frame = page.frameLocator('#f');
    await frame.locator('.card').first().waitFor({ timeout: 10000 });
    const before = (await hostCalls(page)).filter((c) => c.cmd === 'AUTHORIZE').length;
    t.site.sessions.clear(); // bot został zrestartowany: sesje są tylko w pamięci
    await page.frames().find((f) => f !== page.mainFrame()).evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction((n) => window.__calls.filter((c) => c.cmd === 'AUTHORIZE').length > n, before, { timeout: 8000 });
    // po ponownym logowaniu zmiany znowu działają
    const from = await centerOf(frame.locator('.col[data-status="Pomysł"] .card', { hasText: 'Pomysł C' }));
    const to = await centerOf(frame.locator('.col[data-status="Przydzielone"] .col-list'));
    await mouseDrag(page, from, to);
    await frame.locator('.col[data-status="Przydzielone"] .card', { hasText: 'Pomysł C' }).waitFor();
    assert.equal(t.site.sessions.size, 1, 'powstała nowa sesja');
  } finally { await ctx.close(); }
}));

test('Activity: gdy klient Discorda nie odpowie na authenticate, tablica i tak się uruchamia po krótkim czasie', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  try {
    const t0 = Date.now();
    await page.goto(`${t.base}/host.html?code=code-${ID.szef}&noauth=1`);
    await page.frameLocator('#f').locator('.card').first().waitFor({ timeout: 15000 });
    const took = Date.now() - t0;
    assert.ok(took >= 5500 && took < 12000, `uruchomienie po limicie czasu authenticate (${took} ms)`);
  } finally { await ctx.close(); }
}));

test('Activity: osoba spoza redakcji i zły kod widzą komunikat zamiast pustej tablicy', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`${t.base}/host.html?code=code-${ID.obcy}`);
    const frame = page.frameLocator('#f');
    await frame.locator('.center-card h1:has-text("Brak dostępu")').waitFor({ timeout: 10000 });
    assert.equal(await frame.locator('.card').count(), 0);

    const bad = await ctx.newPage();
    await bad.goto(`${t.base}/host.html?code=zly-kod`);
    const f2 = bad.frameLocator('#f');
    await f2.locator('.center-card h1:has-text("Nie udało się uruchomić tablicy")').waitFor({ timeout: 10000 });
    assert.match(await f2.locator('.center-card .error').innerText(), /Logowanie nie powiodło się/);
    assert.equal(t.site.sessions.size, 0);
  } finally { await ctx.close(); }
}));

test('strona otwarta poza Discordem z parametrem frame_id nie zawiesza się: po limicie czasu pokazuje komunikat', { skip: SKIP }, () => withSite({}, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`${t.base}/?frame_id=1&instance_id=2&platform=desktop`);
    await page.waitForSelector('.center-card .error', { timeout: 20000 });
    assert.match(await page.locator('.center-card .error').innerText(), /Discord nie odpowiada/);
  } finally { await ctx.close(); }
}));
