'use strict';
// Autor: Mateusz Bartoszewicz
// Testy interfejsu w prawdziwej przeglądarce: przeciąganie myszą i dotykiem, okna, odświeżanie, treści z Discorda jako tekst.
// Uruchomienie: npm run test:browser (wymaga pakietu playwright i przeglądarki Chromium).
const test = require('node:test');
const assert = require('node:assert/strict');
const { playwright, buildSite, openAs, colSel, cardSel, centerOf, mouseDrag, touchDrag, bootWeb, ID } = require('./helpers');
const { tagId } = require('../fake-discord');
const { taskIn, seed } = require('../web-helpers');

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
const boardOf = async (t, session) => (await t.call(session, 'GET', '/api/board'));
const hasTag = (t, id, status) => t.fake.thread(id).applied_tags.includes(tagId(status));
async function ready(page) { await page.waitForSelector('.card'); }

// ---------------------------------------------------------------- mysz
test('mysz: przeciągnięcie karty do innej kolumny zmienia tag w Discordzie i nie otwiera okna zadania', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    const from = await centerOf(page.locator(cardSel('Pomysł C', 'Pomysł')));
    const to = await centerOf(page.locator(`${colSel('Przydzielone')} .col-list`));

    await mouseDrag(page, from, to, { release: false });
    assert.equal(await page.locator('.ghost').count(), 1, 'w trakcie przeciągania widać kopię karty');
    assert.equal(await page.locator('.card.drag-source').count(), 1, 'oryginał jest przygaszony');
    assert.match(await page.locator(colSel('Przydzielone')).getAttribute('class'), /drop-ok/, 'kolumna docelowa jest podświetlona');
    await page.mouse.up();

    await page.waitForSelector(cardSel('Pomysł C', 'Przydzielone'));
    await page.waitForFunction(() => !document.querySelector('.ghost'));
    assert.equal(await page.locator('.sheet').count(), 0, 'puszczenie przycisku po przeciąganiu nie otwiera okna zadania');
    assert.equal(await page.locator(cardSel('Pomysł C', 'Pomysł')).count(), 0);
    assert.equal(hasTag(t, id, 'Przydzielone'), true, 'tag zmieniony w Discordzie');
    assert.equal(hasTag(t, id, 'Pomysł'), false);
    assert.equal(await page.locator(colSel('Pomysł') + ' .count').innerText(), '1');
    assert.equal(await page.locator(colSel('Przydzielone') + ' .count').innerText(), '1');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('mysz: oddanie tekstu zamienia „po terminie” na „tekst oddany”, a cofnięcie do pisania przywraca czerwony termin', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    const id = taskIn(await boardOf(t, session), 'Recenzja A').id;
    const szef = await t.login(ID.szef);
    assert.equal((await t.call(szef, 'POST', '/api/due', { id, due: '2026-10-20' })).status, 200); // dzisiaj w testach: 24.10
    await ready(page);
    const chip = (status) => page.locator(`${cardSel('Recenzja A', status)} .chip`);

    await page.waitForSelector(`${cardSel('Recenzja A', 'W pisaniu')} .chip.overdue`);
    assert.match(await chip('W pisaniu').first().innerText(), /po terminie/);

    const drag = async (from, to) => {
      const a = await centerOf(page.locator(cardSel('Recenzja A', from)));
      const b = await centerOf(page.locator(`${colSel(to)} .col-list`));
      await mouseDrag(page, a, b);
    };
    await drag('W pisaniu', 'Do redakcji');
    await page.waitForSelector(cardSel('Recenzja A', 'Do redakcji'));
    await page.waitForSelector(`${cardSel('Recenzja A', 'Do redakcji')} .chip.done`);
    assert.equal(await chip('Do redakcji').first().innerText(), 'tekst oddany');
    assert.equal(await page.locator('.chip.overdue').count(), 0, 'na tablicy nie zostaje żaden czerwony termin');
    assert.match(await page.locator(cardSel('Recenzja A', 'Do redakcji')).getAttribute('aria-label'), /Tekst oddany/);
    assert.doesNotMatch(await page.locator(cardSel('Recenzja A', 'Do redakcji')).getAttribute('aria-label'), /po terminie/);
    assert.equal((await boardOf(t, session)).json.tasks.find((x) => x.id === id).due, '2026-10-20', 'termin zostaje zapisany, tylko przestaje straszyć');

    await drag('Do redakcji', 'W pisaniu');
    await page.waitForSelector(`${cardSel('Recenzja A', 'W pisaniu')} .chip.overdue`);
    assert.equal(await page.locator('.chip.done').count(), 0);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('opublikowane zadanie z terminem z przeszłości nie ma żadnej plakietki terminu, a oddane do publikacji pokazuje „tekst oddany”', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    const szef = await t.login(ID.szef);
    const board = await boardOf(t, session);
    const published = taskIn(board, 'Stary D').id;
    const forPublication = taskIn(board, 'Do pub E').id;
    assert.equal((await t.call(szef, 'POST', '/api/due', { id: published, due: '2026-10-20' })).status, 200);
    assert.equal((await t.call(szef, 'POST', '/api/due', { id: forPublication, due: '2026-10-20' })).status, 200);
    await ready(page);
    await page.waitForSelector(`${cardSel('Do pub E', 'Do publikacji')} .chip.done`);
    assert.equal(await page.locator(`${cardSel('Stary D', 'Opublikowane')} .chip`).count(), 0, 'opublikowane nie pokazują terminu');
    assert.equal(await page.locator('.chip.overdue').count(), 0, 'nigdzie nie ma czerwonego „po terminie”');
    assert.equal(await page.locator(`${cardSel('Do pub E', 'Do publikacji')} .chip.done`).innerText(), 'tekst oddany');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('mysz: zwykłe kliknięcie otwiera okno zadania, a Esc je zamyka i oddaje fokus karcie', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const card = page.locator(cardSel('Recenzja A'));
    await card.click();
    await page.waitForSelector('.sheet[role="dialog"]');
    assert.equal(await page.locator('.sheet h2').innerText(), 'Recenzja A');
    assert.equal(await page.locator('.status-btn[aria-pressed="true"]').innerText(), 'W pisaniu');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Zamknij');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sheet', { state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('card')), true, 'fokus wraca na kartę');
    // Enter na karcie też otwiera okno (dostępność z klawiatury)
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('mysz: statusy tylko dla kierownictwa są zablokowane dla redakcji, a kierownictwo może z nich korzystać', { skip: SKIP }, () => withSite({}, async (t) => {
  const autor = await openAs(t, browser, ID.autor);
  const szef = await openAs(t, browser, ID.szef);
  try {
    await ready(autor.page);
    const board = await boardOf(t, autor.session);
    const aId = taskIn(board, 'Recenzja A').id;
    // 1. przeciągnięcie do zablokowanej kolumny
    const from = await centerOf(autor.page.locator(cardSel('Recenzja A', 'W pisaniu')));
    const lockedCol = autor.page.locator(`${colSel('Do publikacji')} .col-list`);
    const to = await centerOf(lockedCol);
    await mouseDrag(autor.page, from, to, { release: false });
    assert.match(await autor.page.locator(colSel('Do publikacji')).getAttribute('class'), /drop-no/, 'kolumna pokazuje, że to miejsce jest niedozwolone');
    await autor.page.mouse.up();
    await autor.page.waitForSelector('.toast.error');
    assert.match(await autor.page.locator('.toast.error').innerText(), /kierownictwo lub moderacja/);
    assert.equal(await autor.page.locator(cardSel('Recenzja A', 'W pisaniu')).count(), 1, 'karta zostaje na miejscu');
    assert.equal(hasTag(t, aId, 'W pisaniu'), true);
    // 2. zadanie, które już jest w zablokowanym statusie, nie daje się chwycić
    const e = await centerOf(autor.page.locator(cardSel('Do pub E', 'Do publikacji')));
    const free = await centerOf(autor.page.locator(`${colSel('Do redakcji')} .col-list`));
    await mouseDrag(autor.page, e, free);
    await autor.page.waitForFunction(() => document.querySelectorAll('.toast.error').length >= 2);
    assert.match(await autor.page.locator('.toast.error').last().innerText(), /Zadania w tym statusie zmienia kierownictwo/);
    assert.equal(await autor.page.locator('.sheet').count(), 0, 'nieudana próba przeciągnięcia nie otwiera karty');
    assert.equal(await autor.page.locator(cardSel('Do pub E', 'Do publikacji')).count(), 1);
    assert.ok(await autor.page.locator(`${colSel('Do publikacji')} .lock`).isVisible(), 'ikona kłódki przy zablokowanej kolumnie');
    // 3. kierownictwo przenosi do "Do publikacji"
    await szef.page.waitForSelector('.card');
    const sFrom = await centerOf(szef.page.locator(cardSel('Recenzja A', 'W pisaniu')));
    const sTo = await centerOf(szef.page.locator(`${colSel('Do publikacji')} .col-list`));
    await mouseDrag(szef.page, sFrom, sTo);
    await szef.page.waitForSelector(cardSel('Recenzja A', 'Do publikacji'));
    assert.equal(await szef.page.locator(colSel('Do publikacji') + ' .lock').isVisible(), false, 'kierownictwo nie widzi kłódki');
    await szef.page.waitForTimeout(150);
    assert.equal(hasTag(t, aId, 'Do publikacji'), true);
    assert.deepEqual([...autor.problems, ...szef.problems], []);
  } finally { await autor.ctx.close(); await szef.ctx.close(); }
}));

test('mysz: puszczenie karty w tej samej kolumnie nic nie zmienia i nie otwiera okna zadania', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    const from = await centerOf(page.locator(cardSel('Pomysł C', 'Pomysł')));
    // Przeciągnięcie o kilkadziesiąt pikseli w obrębie tej samej kolumny: przeglądarka generuje kliknięcie na karcie,
    // które bez tłumienia otworzyłoby okno zadania mimo przeciągania.
    await mouseDrag(page, from, { x: from.x + 20, y: from.y + 40 });
    await page.waitForFunction(() => !document.querySelector('.ghost'));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.sheet').count(), 0, 'po przeciągnięciu okno zadania się nie otwiera');
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${id}$`)).length, 0, 'status bez zmian');
    // Zwykłe kliknięcie zaraz potem nadal działa (tłumienie jest krótkie).
    await page.waitForTimeout(600);
    await page.locator(cardSel('Pomysł C')).click();
    await page.waitForSelector('.sheet');
  } finally { await ctx.close(); }
}));

test('mysz: Esc w trakcie przeciągania anuluje je bez zmiany statusu', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    const from = await centerOf(page.locator(cardSel('Pomysł C', 'Pomysł')));
    const to = await centerOf(page.locator(`${colSel('W pisaniu')} .col-list`));
    await mouseDrag(page, from, to, { release: false });
    assert.equal(await page.locator('.ghost').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ghost'));
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await page.locator(cardSel('Pomysł C', 'Pomysł')).count(), 1);
    assert.equal(hasTag(t, id, 'Pomysł'), true);
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${id}$`)).length, 0, 'do Discorda nic nie poszło');
    assert.equal(await page.locator('.drop-ok, .drop-no').count(), 0, 'po anulowaniu nic nie jest podświetlone');
  } finally { await ctx.close(); }
}));

test('mysz: odmowa po stronie bota cofa kartę na miejsce i pokazuje komunikat', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pełny F').id;
    // Zadanie ma już pięć tagów tematu, więc bot odmówi zmiany statusu (limit tagów w poście na Discordzie).
    const from = await centerOf(page.locator(cardSel('Pełny F', 'Pomysł')));
    const to = await centerOf(page.locator(`${colSel('W pisaniu')} .col-list`));
    await mouseDrag(page, from, to);
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').innerText(), /5 tagów tematu/);
    await page.waitForSelector(cardSel('Pełny F', 'Pomysł'));
    assert.equal(await page.locator(cardSel('Pełny F', 'W pisaniu')).count(), 0, 'karta wróciła do pierwotnej kolumny');
    assert.equal(hasTag(t, id, 'Pomysł'), true, 'tag w Discordzie nietknięty');
  } finally { await ctx.close(); }
}));

test('mysz: przy krawędzi okna tablica sama się przewija, a po puszczeniu karta ląduje w odległej kolumnie', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.szef, { viewport: { width: 900, height: 700 } });
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    assert.equal(await page.evaluate(() => document.querySelector('.board').scrollLeft), 0);
    const from = await centerOf(page.locator(cardSel('Pomysł C', 'Pomysł')));
    await mouseDrag(page, from, { x: 890, y: 300 }, { release: false });
    await page.waitForFunction(() => {
      const b = document.querySelector('.board');
      return b.scrollLeft > 150 && b.scrollLeft + b.clientWidth >= b.scrollWidth - 2;
    }, null, { timeout: 5000 });
    // kolumna "Opublikowane" jest teraz widoczna pod kursorem
    const published = await centerOf(page.locator(`${colSel('Opublikowane')} .col-list`));
    assert.ok(published.x < 900, 'kolumna docelowa jest już widoczna');
    await page.mouse.move(published.x, published.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector(cardSel('Pomysł C', 'Opublikowane'));
    await page.waitForTimeout(150);
    assert.equal(hasTag(t, id, 'Opublikowane'), true);
  } finally { await ctx.close(); }
}));

// ---------------------------------------------------------------- odświeżanie
test('odświeżanie w tle: zmiany z Discorda pojawiają się bez przeładowania, bez zmian dostajemy 304', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.autor);
  const statuses = [];
  page.on('response', (r) => { if (r.url().endsWith('/api/board')) statuses.push(r.status()); });
  const poke = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  try {
    await ready(page);
    await poke();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(250);
    assert.ok(statuses.includes(304), `bez zmian serwer odpowiada 304: ${statuses}`);
    const szef = await t.login(ID.szef);
    const id = taskIn(await boardOf(t, session), 'Recenzja A').id;
    await t.call(szef, 'POST', '/api/move', { id, status: 'Do redakcji' });
    await t.call(szef, 'POST', '/api/urgent', { id, urgent: true });
    await poke();
    await page.waitForSelector(cardSel('Recenzja A', 'Do redakcji'));
    assert.equal(await page.locator(cardSel('Recenzja A', 'Do redakcji') + ' .chip.urgent').count(), 1, 'oznaczenie PILNE też się pojawiło');
    assert.equal(await page.locator('.status-dot').innerText(), 'Na żywo');
  } finally { await ctx.close(); }
}));

test('odświeżanie w tle nie przerywa przeciągania, a zmiany z tła dołączają po puszczeniu karty', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.szef);
  const poke = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  try {
    await ready(page);
    const eId = taskIn(await boardOf(t, session), 'Do pub E').id;
    const from = await centerOf(page.locator(cardSel('Pomysł C', 'Pomysł')));
    const to = await centerOf(page.locator(`${colSel('W pisaniu')} .col-list`));
    await mouseDrag(page, from, to, { release: false });
    // w trakcie przeciągania ktoś inny zmienia coś na tablicy, a strona odświeża dane
    await t.call(session, 'POST', '/api/urgent', { id: eId, urgent: true });
    await poke();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.ghost').count(), 1, 'karta wciąż jest w ręku');
    assert.equal(await page.locator('.card.drag-source').count(), 1);
    await page.mouse.up();
    await page.waitForSelector(cardSel('Pomysł C', 'W pisaniu'));
    await page.waitForSelector(`${cardSel('Do pub E', 'Do publikacji')} .chip.urgent`); // zmiana z tła dołączyła po puszczeniu
  } finally { await ctx.close(); }
}));

test('spóźniona odpowiedź odświeżania sprzed zmiany nie cofa przeniesionej karty', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.szef);
  const poke = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  try {
    await ready(page);
    // Ktoś zmienia tablicę (inny ETag), więc kolejne odświeżenie dostanie pełną migawkę (200), a nie 304.
    const eId = taskIn(await boardOf(t, session), 'Do pub E').id;
    await t.call(session, 'POST', '/api/urgent', { id: eId, urgent: true });
    // Serwer wydaje migawkę od razu (stan sprzed przeniesienia), ale do strony trafia ona dopiero po naszym sygnale.
    let release; let issued;
    const gate = new Promise((r) => { release = r; });
    const snapshotIssued = new Promise((r) => { issued = r; });
    let armed = true;
    await page.route('**/api/board', async (route) => {
      if (!armed) { await route.continue(); return; }
      armed = false;
      const response = await route.fetch();
      issued();
      await gate;
      await route.fulfill({ response });
    });
    await poke();
    await snapshotIssued;
    const from = await centerOf(page.locator(cardSel('Pomysł C', 'Pomysł')));
    const to = await centerOf(page.locator(`${colSel('W pisaniu')} .col-list`));
    await mouseDrag(page, from, to);
    await page.waitForSelector(cardSel('Pomysł C', 'W pisaniu'));
    const cId = taskIn(await boardOf(t, session), 'Pomysł C').id;
    assert.equal((await boardOf(t, session)).json.tasks.find((x) => x.id === cId).status, 'W pisaniu', 'bot zapisał zmianę, zanim spóźniona migawka dotarła');
    release(); // migawka sprzed przeniesienia dociera dopiero teraz
    await page.waitForTimeout(500);
    assert.equal(await page.locator(cardSel('Pomysł C', 'W pisaniu')).count(), 1, 'karta zostaje tam, gdzie ją upuszczono');
    assert.equal(await page.locator(cardSel('Pomysł C', 'Pomysł')).count(), 0, 'stara migawka nie cofnęła karty');
    await page.waitForSelector(`${cardSel('Do pub E', 'Do publikacji')} .chip.urgent`); // zmiana kolegi i tak dołączyła
  } finally { await ctx.close(); }
}));

test('długo trwająca zmiana nie wywołuje lawiny zapytań o tablicę', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.szef);
  const poke = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  try {
    await ready(page);
    const eId = taskIn(await boardOf(t, session), 'Do pub E').id;
    let boardGets = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/api/board', async (route) => { boardGets += 1; await route.continue(); });
    await page.route('**/api/move', async (route) => { await gate; await route.continue(); });
    const from = await centerOf(page.locator(cardSel('Pomysł C', 'Pomysł')));
    const to = await centerOf(page.locator(`${colSel('W pisaniu')} .col-list`));
    await mouseDrag(page, from, to);
    await page.waitForSelector(cardSel('Pomysł C', 'W pisaniu')); // widoczne od razu, zapis jeszcze czeka
    boardGets = 0;
    await t.call(session, 'POST', '/api/urgent', { id: eId, urgent: true }); // tablica na serwerze się zmienia, więc odświeżenie dostaje 200, a nie 304
    await poke();
    await page.waitForTimeout(1500);
    assert.ok(boardGets <= 2, `w czasie trwania zmiany poszło ${boardGets} zapytań o tablicę`);
    release();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(cardSel('Pomysł C', 'W pisaniu')).count(), 1);
  } finally { await ctx.close(); }
}));

// ---------------------------------------------------------------- okna
test('okno zadania: gdy bot odmówi przydziału, lista osób wraca do prawdziwego stanu zamiast pokazywać fałszywą osobę', { skip: SKIP }, () => withSite({}, async (t) => {
  await t.login(ID.oliwia);
  const { ctx, page } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    await page.route('**/api/assign', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Tej osoby nie można przydzielić.' }) }));
    await page.locator(cardSel('Pomysł C')).click();
    await page.waitForSelector('.sheet');
    await page.focus('#assign-select'); // prawdziwy użytkownik wybiera z listy, która ma wtedy fokus (selectOption sam fokusu nie ustawia)
    await page.selectOption('#assign-select', ID.oliwia);
    await page.waitForSelector('.toast.error');
    await page.waitForTimeout(400); // czas na odświeżenie tablicy po błędzie
    assert.match(await page.locator('.toast.error').innerText(), /nie można przydzielić/);
    // Zadanie nie ma przydziału, więc osobą jest autor posta (tak liczy to bot); lista ma to pokazywać, a nie Oliwię, której przydział się nie udał.
    assert.equal(await page.locator('#assign-select').inputValue(), ID.autor, 'lista wróciła do osoby z serwera');
  } finally { await ctx.close(); }
}));

test('okno zadania: status, osoba, termin i pilne zapisują się w Discordzie', { skip: SKIP }, () => withSite({}, async (t) => {
  await t.login(ID.oliwia); // bot "poznaje" osobę, dopiero wtedy trafia ona na listę do przydziału
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    await page.locator(cardSel('Pomysł C')).click();
    await page.waitForSelector('.sheet');
    // status
    await page.locator('.status-btn', { hasText: 'Przydzielone' }).click();
    await page.waitForSelector(cardSel('Pomysł C', 'Przydzielone'));
    assert.equal(await page.locator('.status-btn[aria-pressed="true"]').innerText(), 'Przydzielone', 'okno odświeżyło się po zmianie');
    // zablokowane statusy są wyłączone, z podpowiedzią
    assert.equal(await page.locator('.status-btn', { hasText: 'Do publikacji' }).isDisabled(), true);
    assert.ok(await page.locator('.sheet .hint', { hasText: 'Do publikacji' }).isVisible());
    // termin
    await page.fill('#due-input', '2026-11-05');
    await page.locator('button', { hasText: 'Zapisz termin' }).click();
    await page.waitForSelector('button:has-text("Usuń termin")');
    await page.waitForSelector(`${cardSel('Pomysł C')} .chip:has-text("5 lis")`);
    // pilne
    await page.locator('#urgent-input').check();
    await page.waitForSelector(`${cardSel('Pomysł C')} .chip.urgent`);
    // osoba
    const oliwiaName = await page.locator(`#assign-select option[value="${ID.oliwia}"]`).innerText();
    await page.selectOption('#assign-select', ID.oliwia);
    await page.waitForFunction((n) => document.querySelector('.who-line').textContent.includes(n), oliwiaName);
    const b = (await boardOf(t, session)).json;
    const task = b.tasks.find((x) => x.id === id);
    assert.equal(task.status, 'Przydzielone');
    assert.equal(task.due, '2026-11-05');
    assert.equal(task.urgent, true);
    assert.equal(task.assigneeId, ID.oliwia);
    // termin da się usunąć
    await page.locator('button', { hasText: 'Usuń termin' }).click();
    await page.waitForSelector(`${cardSel('Pomysł C')} .chip:has-text("5 lis")`, { state: 'detached' });
    assert.equal((await boardOf(t, session)).json.tasks.find((x) => x.id === id).due, null);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('okno zadania: "Biorę to" i "Zwolnij" oraz błąd serwera pokazany jako komunikat', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.oliwia);
  try {
    await ready(page);
    const created = await t.call(session, 'POST', '/api/task', { title: 'Wolne zadanie' });
    const id = created.json.task.id;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForSelector(cardSel('Wolne zadanie', 'Pomysł'));
    await page.locator(cardSel('Wolne zadanie')).click();
    await page.locator('button', { hasText: 'Biorę to' }).click();
    await page.waitForSelector(cardSel('Wolne zadanie', 'Przydzielone'));
    assert.equal(await page.locator('button', { hasText: 'Biorę to' }).isHidden(), true);
    assert.equal((await boardOf(t, session)).json.tasks.find((x) => x.id === id).assigneeId, ID.oliwia);
    await page.locator('button', { hasText: 'Zwolnij' }).click();
    await page.waitForSelector(cardSel('Wolne zadanie', 'Pomysł'));
    // błędny termin: komunikat od bota, okno zostaje otwarte
    // Pole daty nie przyjmie "jutro"; przeglądarki bez obsługi type=date pokazują zwykłe pole tekstowe, więc je symulujemy.
    await page.evaluate(() => { document.querySelector('#due-input').type = 'text'; });
    await page.fill('#due-input', 'jutro');
    await page.locator('button', { hasText: 'Zapisz termin' }).click();
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').innerText(), /Nie rozumiem terminu/);
    assert.equal(await page.locator('.sheet').count(), 1);
  } finally { await ctx.close(); }
}));

test('nowe zadanie: formularz tworzy post na forum z osobą, terminem i opisem; pusty tytuł daje komunikat', { skip: SKIP }, () => withSite({}, async (t) => {
  await t.login(ID.oliwia);
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    await page.locator('.topbar .btn.primary').click();
    await page.waitForSelector('#new-title');
    // pusty tytuł
    await page.locator('button[type="submit"]').click();
    assert.match(await page.locator('.form-error').innerText(), /Podaj tytuł/);
    assert.equal((t.fake.created || []).length, 0, 'pusty tytuł nie tworzy posta');
    await page.fill('#new-title', 'Zadanie z formularza');
    await page.selectOption('#new-person', ID.oliwia);
    await page.fill('#new-due', '2026-11-12');
    await page.fill('#new-desc', 'Źródła w wątku');
    await page.locator('button[type="submit"]').click();
    await page.waitForSelector(cardSel('Zadanie z formularza', 'Przydzielone'));
    await page.waitForSelector('.sheet', { state: 'detached' });
    assert.equal(t.fake.created.length, 1);
    assert.equal(t.fake.created[0].body.name, 'Zadanie z formularza');
    assert.equal(t.fake.created[0].body.message.content, 'Źródła w wątku');
    const task = (await boardOf(t, session)).json.tasks.find((x) => x.name === 'Zadanie z formularza');
    assert.equal(task.assigneeId, ID.oliwia);
    assert.equal(task.due, '2026-11-12');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

// ---------------------------------------------------------------- dwa terminy
test('dwa terminy na kartach: w pisaniu wcześniejszy z drugim jako notatką, po oddaniu tylko publikacja (czerwona po terminie), opublikowane bez plakietek', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    const board = await boardOf(t, session);
    const writing = taskIn(board, 'Recenzja A').id;
    const forPublication = taskIn(board, 'Do pub E').id;
    const szef = await t.login(ID.szef);
    // dzisiaj w testach: 24.10
    assert.equal((await t.call(szef, 'POST', '/api/due', { id: writing, due: '2026-10-26', pubDue: '2026-10-28' })).status, 200);
    assert.equal((await t.call(szef, 'POST', '/api/due', { id: forPublication, due: '2026-10-20', pubDue: '2026-10-23' })).status, 200);
    await ready(page);
    const chips = (name, status) => page.locator(`${cardSel(name, status)} .chip`).allInnerTexts();

    await page.waitForSelector(`${cardSel('Recenzja A', 'W pisaniu')} .chip:has-text("publikacja 28 paź")`);
    assert.deepEqual(await chips('Recenzja A', 'W pisaniu'), ['26 paź', 'publikacja 28 paź'], 'wcześniejszy termin liczy się, drugi jest tylko notatką');
    assert.equal(await page.locator(`${cardSel('Recenzja A', 'W pisaniu')} .chip.soon`).count(), 1, 'kolor ma tylko termin, który się liczy');
    assert.match(await page.locator(cardSel('Recenzja A', 'W pisaniu')).getAttribute('aria-label'), /Termin: 26 paź.*Publikacja: 28 paź/);

    await page.waitForSelector(`${cardSel('Do pub E', 'Do publikacji')} .chip.overdue`);
    assert.deepEqual(await chips('Do pub E', 'Do publikacji'), ['publikacja 23 paź · po terminie'], 'po oddaniu liczy się tylko premiera');
    assert.match(await page.locator(cardSel('Do pub E', 'Do publikacji')).getAttribute('aria-label'), /Publikacja: 23 paź · po terminie/);

    const a = await centerOf(page.locator(cardSel('Recenzja A', 'W pisaniu')));
    const b = await centerOf(page.locator(`${colSel('Do redakcji')} .col-list`));
    await mouseDrag(page, a, b);
    await page.waitForSelector(cardSel('Recenzja A', 'Do redakcji'));
    await page.waitForSelector(`${cardSel('Recenzja A', 'Do redakcji')} .chip:has-text("publikacja 28 paź")`);
    assert.deepEqual(await chips('Recenzja A', 'Do redakcji'), ['publikacja 28 paź'], 'oddanie przestało się liczyć, została premiera');

    // opublikowane: żadnej plakietki, mimo minionej premiery
    assert.equal((await t.call(szef, 'POST', '/api/move', { id: forPublication, status: 'Opublikowane' })).status, 200);
    await page.waitForSelector(cardSel('Do pub E', 'Opublikowane'));
    assert.equal(await page.locator(`${cardSel('Do pub E', 'Opublikowane')} .chip`).count(), 0);
    assert.equal(await page.locator('.chip.overdue').count(), 0, 'nigdzie nie ma czerwonego terminu');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('okno zadania: termin publikacji zapisuje się i usuwa osobno, nie rusząc terminu oddania', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    await page.locator(cardSel('Pomysł C')).click();
    await page.waitForSelector('.sheet');
    assert.equal(await page.locator('button', { hasText: 'Usuń publikację' }).isHidden(), true, 'bez terminu nie ma czego usuwać');
    await page.fill('#due-input', '2026-11-05');
    await page.locator('button', { hasText: 'Zapisz termin' }).click();
    await page.waitForSelector('button:has-text("Usuń termin")');
    await page.fill('#pub-input', '2026-11-12');
    await page.locator('button', { hasText: 'Zapisz publikację' }).click();
    await page.waitForSelector('button:has-text("Usuń publikację")');
    await page.waitForSelector(`${cardSel('Pomysł C')} .chip:has-text("publikacja 12 lis")`);
    let task = (await boardOf(t, session)).json.tasks.find((x) => x.id === id);
    assert.deepEqual([task.due, task.pubDue], ['2026-11-05', '2026-11-12']);
    assert.equal(await page.inputValue('#due-input'), '2026-11-05');
    assert.equal(await page.inputValue('#pub-input'), '2026-11-12');

    await page.locator('button', { hasText: 'Usuń publikację' }).click();
    await page.waitForSelector(`${cardSel('Pomysł C')} .chip:has-text("publikacja")`, { state: 'detached' });
    task = (await boardOf(t, session)).json.tasks.find((x) => x.id === id);
    assert.deepEqual([task.due, task.pubDue], ['2026-11-05', null], 'usunięcie publikacji zostawia oddanie');
    assert.equal(await page.inputValue('#pub-input'), '');

    // błędny termin publikacji: komunikat od bota, okno zostaje otwarte
    await page.evaluate(() => { document.querySelector('#pub-input').type = 'text'; });
    await page.fill('#pub-input', 'premiera');
    await page.locator('button', { hasText: 'Zapisz publikację' }).click();
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').innerText(), /Nie rozumiem terminu publikacji/);
    assert.equal(await page.locator('.sheet').count(), 1);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('nowe zadanie: formularz ma osobne pole terminu publikacji', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    await page.locator('.topbar .btn.primary').click();
    await page.waitForSelector('#new-title');
    await page.fill('#new-title', 'Premiera gry');
    await page.fill('#new-due', '2026-11-10');
    await page.fill('#new-pubdue', '2026-11-12');
    await page.locator('button[type="submit"]').click();
    await page.waitForSelector(`${cardSel('Premiera gry', 'Pomysł')} .chip:has-text("publikacja 12 lis")`);
    const task = (await boardOf(t, session)).json.tasks.find((x) => x.name === 'Premiera gry');
    assert.deepEqual([task.due, task.pubDue], ['2026-11-10', '2026-11-12']);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

// ---------------------------------------------------------------- filtry
test('filtry: Moje, Pilne i Bez osoby ograniczają karty i liczniki, a wybór jest pamiętany', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    const szef = await t.login(ID.szef);
    await t.call(session, 'POST', '/api/urgent', { id: taskIn(await boardOf(t, session), 'Pomysł C').id, urgent: true });
    await t.call(szef, 'POST', '/api/task', { title: 'Bez osoby' });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForSelector(cardSel('Bez osoby'));
    const names = async () => (await page.locator('.col .card .card-title').allInnerTexts()).sort();
    await page.locator('.filters button', { hasText: 'Pilne' }).click();
    assert.deepEqual(await names(), ['Pomysł C']);
    await page.locator('.filters button', { hasText: 'Moje' }).click();
    assert.deepEqual(await names(), ['Pełny F', 'Pomysł C', 'Recenzja A', 'Stary D'].sort());
    assert.equal(await page.locator(colSel('Pomysł') + ' .count').innerText(), '2');
    await page.locator('.filters button', { hasText: 'Bez osoby' }).click();
    assert.deepEqual(await names(), ['Bez osoby'].sort());
    assert.equal(await page.locator(colSel('Opublikowane') + ' .empty').innerText(), 'Brak zadań dla tego filtru');
    await page.reload();
    await page.waitForSelector('.card');
    assert.equal(await page.locator('.filters button[aria-pressed="true"]').innerText(), 'Bez osoby', 'filtr przetrwał przeładowanie');
  } finally { await ctx.close(); }
}));

// ---------------------------------------------------------------- bezpieczeństwo treści
test('tytuły i nazwy z Discorda są wyłącznie tekstem: znaczniki HTML nie wykonują kodu', { skip: SKIP }, () => withSite({
  seedFn: (fake) => { fake.addThread({ name: '<img src=x onerror=alert(1)>Atak', owner: ID.autor, status: 'Pomysł', content: '' }); },
}, async (t) => {
  const { ctx, page, problems } = await openAs(t, browser, ID.autor);
  try {
    await ready(page);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.card-title').first().innerText(), '<img src=x onerror=alert(1)>Atak');
    assert.equal(await page.locator('.card img[src="x"], .board img[src="x"]').count(), 0);
    await page.locator('.card').first().click();
    assert.equal(await page.locator('.sheet h2').innerText(), '<img src=x onerror=alert(1)>Atak');
    assert.equal(await page.locator('.sheet img[src="x"]').count(), 0);
    assert.deepEqual(problems, [], 'żadne okno alert ani błąd skryptu');
  } finally { await ctx.close(); }
}));

// ---------------------------------------------------------------- telefon i dotyk
const phone = () => ({ ...playwright.devices['Pixel 5'] });

test('telefon: układ z zakładkami; uchwyt przeciąga kartę na zakładkę statusu', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor, { device: phone() });
  try {
    await ready(page);
    assert.ok(await page.locator('.tabs').isVisible(), 'na wąskim ekranie są zakładki');
    assert.equal(await page.locator(colSel('Przydzielone')).isVisible(), false, 'widać tylko jedną kolumnę');
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    const cdp = await ctx.newCDPSession(page);
    const grip = await centerOf(page.locator(`${cardSel('Pomysł C', 'Pomysł')} .grip`));
    const tab = await centerOf(page.locator('.tab', { hasText: 'Przydzielone' }));
    await touchDrag(cdp, page, grip, tab, { release: false });
    assert.equal(await page.locator('.ghost').count(), 1, 'karta podniesiona palcem');
    assert.match(await page.locator('.tab', { hasText: 'Przydzielone' }).getAttribute('class'), /drop-ok/);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => !document.querySelector('.ghost'));
    await page.waitForTimeout(250);
    assert.equal(hasTag(t, id, 'Przydzielone'), true, 'status zmieniony w Discordzie');
    assert.equal(await page.locator('.sheet').count(), 0);
    await page.locator('.tab', { hasText: 'Przydzielone' }).tap();
    await page.waitForSelector(cardSel('Pomysł C', 'Przydzielone'));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('telefon: długie przytrzymanie karty zaczyna przeciąganie, a szybki ruch palca przewija listę zamiast przeciągać', { skip: SKIP }, () => withSite({
  seedFn: (fake) => {
    seed(fake);
    for (let i = 1; i <= 14; i += 1) fake.addThread({ name: `Zadanie ${String(i).padStart(2, '0')}`, owner: ID.autor, status: 'Pomysł', content: '' });
  },
}, async (t) => {
  const { ctx, page, problems, session } = await openAs(t, browser, ID.autor, { device: phone() });
  try {
    await ready(page);
    const cdp = await ctx.newCDPSession(page);
    const list = page.locator(`${colSel('Pomysł')} .col-list`);
    const scrollTop = () => list.evaluate((el) => el.scrollTop);
    assert.equal(await scrollTop(), 0);
    assert.ok(await list.evaluate((el) => el.scrollHeight > el.clientHeight), 'lista jest dłuższa niż ekran');

    // 1. szybkie przeciągnięcie palcem po treści karty = przewijanie
    const body = await centerOf(page.locator('.card .card-title').first());
    await touchDrag(cdp, page, { x: body.x, y: body.y + 220 }, { x: body.x, y: body.y - 40 }, { hold: 0, steps: 6 });
    await page.waitForTimeout(250);
    assert.ok(await scrollTop() > 40, 'lista się przewinęła');
    assert.equal(await page.locator('.ghost').count(), 0, 'przewijanie nie uruchomiło przeciągania');

    // 2. długie przytrzymanie karty, potem ruch na zakładkę
    await list.evaluate((el) => { el.scrollTop = 0; });
    const title = page.locator(`${colSel('Pomysł')} .card`, { hasText: 'Pomysł C' }).locator('.card-title');
    await title.scrollIntoViewIfNeeded();
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    const start = await centerOf(title);
    const tab = await centerOf(page.locator('.tab', { hasText: 'W pisaniu' }));
    await touchDrag(cdp, page, start, tab, { hold: 500, steps: 12, release: false });
    assert.equal(await page.locator('.ghost').count(), 1, 'po przytrzymaniu karta jest podniesiona');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => !document.querySelector('.ghost'));
    await page.waitForTimeout(250);
    assert.equal(hasTag(t, id, 'W pisaniu'), true);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
}));

test('telefon: stuknięcie karty otwiera okno, a przyciski statusów działają jako zapasowy sposób zmiany', { skip: SKIP }, () => withSite({}, async (t) => {
  const { ctx, page, session } = await openAs(t, browser, ID.autor, { device: phone() });
  try {
    await ready(page);
    const id = taskIn(await boardOf(t, session), 'Pomysł C').id;
    await page.locator(cardSel('Pomysł C')).tap();
    await page.waitForSelector('.sheet');
    await page.locator('.status-btn', { hasText: 'W pisaniu' }).tap();
    await page.waitForFunction(() => document.querySelector('.status-btn[aria-pressed="true"]').textContent.trim() === 'W pisaniu');
    assert.equal(hasTag(t, id, 'W pisaniu'), true);
    await page.locator('.sheet-head .icon-btn').tap();
    await page.waitForSelector('.sheet', { state: 'detached' });
    await page.locator('.tab', { hasText: 'W pisaniu' }).tap();
    await page.waitForSelector(cardSel('Pomysł C', 'W pisaniu'));
  } finally { await ctx.close(); }
}));
