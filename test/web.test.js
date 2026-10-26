'use strict';
// Autor: Mateusz Bartoszewicz
// Testy strony z tablicą: logowanie (Activity i przeglądarka), API, uprawnienia, bezpieczeństwo zapytań, pliki statyczne.
// Prawdziwy bot (discord.js) rozmawia z fałszywym Discordem, a serwer HTTP z fałszywym OAuth2 Discorda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { boot, ID } = require('./helpers');
const { tagId } = require('./fake-discord');
const { loadConfig } = require('../src/config');

const { NOW, sleep, waitFor, PNG, BOARD_ENV, seed, bootWeb, taskIn, cardsIn } = require('./web-helpers');


// ---------------------------------------------------------------- konfiguracja
test('config: ustawienia strony mają bezpieczne wartości domyślne i czytelne błędy', () => {
  const OK = { DISCORD_TOKEN: 'abc.def', GUILD_ID: '123456789012345678' };
  const c = loadConfig(OK);
  assert.equal(c.web.enabled, false, 'bez sekretu aplikacji strony nie ma');
  assert.equal(c.web.port, 8080);
  assert.equal(c.web.publicUrl, null);
  assert.equal(c.web.trustProxy, false);
  assert.equal(c.web.activity, false);
  const on = loadConfig({ ...OK, DISCORD_CLIENT_SECRET: 'x\r', PUBLIC_URL: 'https://tablica.gameby.pl/\r' });
  assert.equal(on.web.enabled, true);
  assert.equal(on.web.publicUrl, 'https://tablica.gameby.pl');
  assert.equal(on.web.clientSecret, 'x');
  assert.throws(() => loadConfig({ ...OK, PUBLIC_URL: 'http://tablica.gameby.pl' }), /https/);
  assert.throws(() => loadConfig({ ...OK, PUBLIC_URL: 'https://tablica.gameby.pl/panel' }), /bez ścieżki/);
  assert.throws(() => loadConfig({ ...OK, PUBLIC_URL: 'tablica' }), /pełny adres/);
  assert.equal(loadConfig({ ...OK, PUBLIC_URL: 'http://localhost:8080' }).web.publicUrl, 'http://localhost:8080');
  assert.throws(() => loadConfig({ ...OK, HTTP_PORT: '99999' }), /HTTP_PORT/);
  assert.throws(() => loadConfig({ ...OK, SESSION_HOURS: '0' }), /SESSION_HOURS/);
});

test('bez DISCORD_CLIENT_SECRET strona się nie uruchamia, a tablica w Discordzie nie ma nowych przycisków', async () => {
  const t = await boot({ env: BOARD_ENV, now: () => NOW, seed });
  try {
    assert.equal(t.app.site(), null);
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const header = t.fake.messagesOf(ID.ogolne).find((m) => m.embeds[0] && m.embeds[0].title === 'Tablica redakcji' && m.components.length);
    assert.deepEqual(header.components[0].components.map((c) => c.custom_id), ['kb:new']);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- logowanie jako Activity
test('Activity: kod z SDK daje sesję tylko osobom z dostępem do forum; token trafia do klienta, a nie do magazynu', async () => {
  const t = await bootWeb();
  try {
    const cfg = await t.call(null, 'GET', '/api/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json.clientId, ID.app);
    assert.deepEqual(cfg.json.restricted, ['Do publikacji', 'Opublikowane']);

    const ok = await t.call(null, 'POST', '/api/token', { code: `code-${ID.autor}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.access_token, `tok-${ID.autor}`);
    assert.match(ok.json.session, /^[A-Za-z0-9_-]{40,}$/);
    const exchange = t.oauth.requests.find((r) => r.path === '/oauth2/token');
    assert.equal(exchange.form.client_secret, 'sekret');
    assert.equal(exchange.form.redirect_uri, undefined, 'przy Activity nie ma adresu powrotu');
    assert.deepEqual(t.oauth.revoked, [], 'token Activity jest potrzebny klientowi');

    const bad = await t.call(null, 'POST', '/api/token', { code: 'zly-kod' });
    assert.equal(bad.status, 401);
    const stranger = await t.call(null, 'POST', '/api/token', { code: `code-${ID.obcy}` });
    assert.equal(stranger.status, 403, 'członek serwera bez roli Redakcja nie dostaje sesji');
    assert.equal(stranger.json.error, 'Ta funkcja jest tylko dla redakcji.');
    const gone = await t.call(null, 'POST', '/api/token', { code: 'code-100000000000009999' });
    assert.equal(gone.status, 403, 'osoba spoza serwera');
    assert.equal(t.site.sessions.size, 1, 'sesja powstała tylko dla jednej osoby');
    const noBody = await t.call(null, 'POST', '/api/token', {});
    assert.equal(noBody.status, 400);
    const wrongType = await fetch(`${t.base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(wrongType.status, 415);
  } finally { await t.close(); }
});

test('API bez sesji, ze zmyśloną sesją albo po wylogowaniu odpowiada 401', async () => {
  const t = await bootWeb();
  try {
    assert.equal((await t.call(null, 'GET', '/api/board')).status, 401);
    assert.equal((await t.call('x'.repeat(43), 'GET', '/api/board')).status, 401);
    assert.equal((await t.call(null, 'POST', '/api/move', { id: ID.forum, status: 'Pomysł' })).status, 401);
    const s = await t.login(ID.autor);
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 200);
    assert.equal((await t.call(s, 'POST', '/api/logout', {})).status, 200);
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 401);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- tablica
test('/api/board: kolumny w kolejności, osoba, uprawnienie kierownictwa, ETag i 304', async () => {
  const t = await bootWeb();
  try {
    const autor = await t.login(ID.autor);
    const szef = await t.login(ID.szef);
    const r = await t.call(autor, 'GET', '/api/board');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.statuses, ['Pomysł', 'Przydzielone', 'W pisaniu', 'Do redakcji', 'Do publikacji', 'Opublikowane']);
    assert.equal(r.json.today, '2026-10-24');
    assert.equal(r.json.me.id, ID.autor);
    assert.equal(r.json.me.canManage, false);
    assert.equal(r.json.publishedTotal, 1);
    assert.deepEqual(r.json.writingDone, ['Do redakcji', 'Do publikacji', 'Opublikowane'], 'serwer mówi przeglądarce, które statusy znaczą „tekst oddany”');
    assert.deepEqual(r.json.tasks.map((x) => x.name).sort(), ['Do pub E', 'Pełny F', 'Pomysł C', 'Recenzja A', 'Stary D'].sort());
    const a = taskIn(r, 'Recenzja A');
    assert.deepEqual(Object.keys(a).sort(), ['assigneeId', 'due', 'id', 'name', 'pubDue', 'social', 'status', 'urgent', 'url']);
    assert.equal(a.status, 'W pisaniu');
    assert.equal(a.assigneeId, ID.autor, 'bez osoby na karcie zadanie ma autora posta');
    assert.equal(a.url, `https://discord.com/channels/${ID.guild}/${a.id}`);
    const order = r.json.tasks.map((x) => x.status);
    const idx = (s) => ['Pomysł', 'Przydzielone', 'W pisaniu', 'Do redakcji', 'Do publikacji', 'Opublikowane'].indexOf(s);
    assert.deepEqual(order, [...order].sort((x, y) => idx(x) - idx(y)), 'zadania są pogrupowane według kolumn');

    assert.equal((await t.call(szef, 'GET', '/api/board')).json.me.canManage, true);

    const etag = r.headers.get('etag');
    assert.ok(etag);
    const again = await t.call(autor, 'GET', '/api/board', undefined, { 'If-None-Match': etag });
    assert.equal(again.status, 304);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'brak CORS');
  } finally { await t.close(); }
});

test('/api/people: osoby z dostępem do forum, awatary jako data:, bez osób spoza redakcji', async () => {
  const t = await bootWeb();
  try {
    const autor = await t.login(ID.autor);
    await t.login(ID.szef);
    const r = await t.call(autor, 'GET', '/api/people');
    assert.equal(r.status, 200);
    const ids = r.json.people.map((p) => p.id).sort();
    assert.deepEqual(ids, [ID.autor, ID.szef].sort());
    assert.ok(r.json.people.every((p) => p.avatar === PNG && typeof p.name === 'string' && p.name));
    assert.ok(!ids.includes(ID.obcy));
  } finally { await t.close(); }
});

test('MEMBERS_INTENT=1: lista osób obejmuje wszystkich członków z dostępem do forum', async () => {
  const t = await bootWeb({ env: { MEMBERS_INTENT: '1' } });
  try {
    assert.ok(t.fake.intents & (1 << 1), 'bot prosi o Server Members Intent');
    const autor = await t.login(ID.autor);
    const r = await t.call(autor, 'GET', '/api/people');
    assert.deepEqual(r.json.people.map((p) => p.id).sort(), [ID.autor, ID.szef, ID.oliwia].sort());
  } finally { await t.close(); }
});

test('bez MEMBERS_INTENT bot nie prosi o dodatkowe uprawnienia', async () => {
  const t = await bootWeb();
  try {
    assert.equal(t.fake.intents & (1 << 1), 0);
    assert.equal(t.fake.intents & (1 << 15), 0);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- zmiany
test('przeniesienie karty: tag w Discordzie, karta w poście, świeża tablica; tagi tematów zostają', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    const before = await t.call(s, 'GET', '/api/board');
    const a = taskIn(before, 'Recenzja A');
    const rev0 = t.app.bot.web.revision();
    const r = await t.call(s, 'POST', '/api/move', { id: a.id, status: 'Do redakcji' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.task.status, 'Do redakcji');
    assert.deepEqual(t.fake.thread(a.id).applied_tags, [tagId('Technologia'), tagId('Do redakcji')]);
    assert.ok(t.app.bot.web.revision() > rev0);
    const card = await waitFor(() => cardsIn(t.fake, a.id)[0]);
    assert.equal(card.content, 'Status: **Do redakcji**');
    const after = await t.call(s, 'GET', '/api/board');
    assert.equal(taskIn(after, 'Recenzja A').status, 'Do redakcji', 'po zmianie tablica nie zwraca starej pamięci podręcznej');
    assert.notEqual(after.headers.get('etag'), before.headers.get('etag'));
    // to samo przeniesienie drugi raz nic nie psuje
    const again = await t.call(s, 'POST', '/api/move', { id: a.id, status: 'Do redakcji' });
    assert.equal(again.status, 200);
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${a.id}$`)).length, 1, 'bez drugiego zapisu tagów');
  } finally { await t.close(); }
});

test('żywa tablica w Discordzie odświeża się po zmianie ze strony', async () => {
  const t = await bootWeb();
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const column = (title) => t.fake.messagesOf(ID.ogolne).find((m) => m.embeds[0] && m.embeds[0].title.startsWith(title));
    assert.match(column('Do redakcji').embeds[0].title, /· 0$/);
    const s = await t.login(ID.autor);
    const a = taskIn(await t.call(s, 'GET', '/api/board'), 'Recenzja A');
    await t.call(s, 'POST', '/api/move', { id: a.id, status: 'Do redakcji' });
    await waitFor(() => /· 1$/.test(column('Do redakcji').embeds[0].title));
    assert.match(column('Do redakcji').embeds[0].title, /· 1$/);
    assert.match(column('Do redakcji').embeds[0].description, /Recenzja A/);
  } finally { await t.close(); }
});

test('statusy „Do publikacji” i „Opublikowane” (także wyjście z nich) tylko dla kierownictwa', async () => {
  const t = await bootWeb();
  try {
    const autor = await t.login(ID.autor);
    const szef = await t.login(ID.szef);
    const b = await t.call(autor, 'GET', '/api/board');
    const a = taskIn(b, 'Recenzja A');
    const e = taskIn(b, 'Do pub E');
    const into = await t.call(autor, 'POST', '/api/move', { id: a.id, status: 'Do publikacji' });
    assert.equal(into.status, 403);
    assert.match(into.json.error, /kierownictwo lub moderacja/);
    const out = await t.call(autor, 'POST', '/api/move', { id: e.id, status: 'Do redakcji' });
    assert.equal(out.status, 403);
    assert.equal(t.fake.thread(e.id).applied_tags.includes(tagId('Do publikacji')), true, 'nic się nie zmieniło');
    const ok = await t.call(szef, 'POST', '/api/move', { id: e.id, status: 'Opublikowane' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.task.status, 'Opublikowane');
  } finally { await t.close(); }
});

test('przeniesienie: zły status, zły numer, usunięty post, post spoza forum i pięć tagów tematu', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    const b = await t.call(s, 'GET', '/api/board');
    const a = taskIn(b, 'Recenzja A');
    const bad = await t.call(s, 'POST', '/api/move', { id: a.id, status: 'Wymyślony' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'Nie ma takiego statusu.');
    assert.equal((await t.call(s, 'POST', '/api/move', { id: 'abc', status: 'Pomysł' })).status, 400);
    assert.equal((await t.call(s, 'POST', '/api/move', { id: a.id })).status, 400);
    const missing = await t.call(s, 'POST', '/api/move', { id: '999999999999999999', status: 'Pomysł' });
    assert.equal(missing.status, 404, missing.text);
    assert.match(missing.json.error, /Nie ma takiego zadania/);
    const notThread = await t.call(s, 'POST', '/api/move', { id: ID.ogolne, status: 'Pomysł' });
    assert.equal(notThread.status, 404, 'kanał tekstowy to nie zadanie');
    const f = taskIn(b, 'Pełny F');
    const full = await t.call(s, 'POST', '/api/move', { id: f.id, status: 'Przydzielone' });
    assert.equal(full.status, 400);
    assert.match(full.json.error, /5 tagów tematu/);
  } finally { await t.close(); }
});

test('przydział: weź, zwolnij (tylko swoje), przydziel innej osobie z powiadomieniem, zdejmij osobę', async () => {
  const t = await bootWeb();
  try {
    const autor = await t.login(ID.autor);
    const oliwia = await t.login(ID.oliwia);
    const created = await t.call(autor, 'POST', '/api/task', { title: 'Wolne zadanie' });
    assert.equal(created.status, 200, created.text);
    const id = created.json.task.id;
    assert.equal(created.json.task.assigneeId, null);
    assert.equal(created.json.task.status, 'Pomysł');

    const take = await t.call(oliwia, 'POST', '/api/take', { id });
    assert.equal(take.json.task.assigneeId, ID.oliwia);
    assert.equal(take.json.task.status, 'Przydzielone', 'przydział przestawia Pomysł na Przydzielone');
    const takeAgain = await t.call(autor, 'POST', '/api/take', { id });
    assert.equal(takeAgain.status, 400, 'cudzego zadania nie przejmiesz');
    assert.match(takeAgain.json.error, /ma już osobę/);
    const releaseForeign = await t.call(autor, 'POST', '/api/release', { id });
    assert.equal(releaseForeign.status, 400);
    const release = await t.call(oliwia, 'POST', '/api/release', { id });
    assert.equal(release.json.task.assigneeId, null);
    assert.equal(release.json.task.status, 'Pomysł', 'zwolnienie cofa Przydzielone na Pomysł');

    const set = await t.call(autor, 'POST', '/api/assign', { id, userId: ID.oliwia });
    assert.equal(set.json.task.assigneeId, ID.oliwia);
    const ping = await waitFor(() => t.fake.messagesOf(id).find((m) => /to zadanie jest teraz Twoje/.test(m.content)));
    assert.match(ping.content, new RegExp(`^<@${ID.oliwia}> to zadanie jest teraz Twoje \\(przydzielił\\(a\\): <@${ID.autor}>\\)`));
    assert.deepEqual(ping.allowed_mentions, { users: [ID.oliwia] }, 'ping tylko dla przydzielonej osoby');
    const same = await t.call(autor, 'POST', '/api/assign', { id, userId: ID.oliwia });
    assert.equal(same.status, 200);
    assert.equal(t.fake.messagesOf(id).filter((m) => /teraz Twoje/.test(m.content)).length, 1, 'druga prośba nie wysyła drugiego pinga');
    const clear = await t.call(autor, 'POST', '/api/assign', { id, userId: null });
    assert.equal(clear.json.task.assigneeId, null);
    const outsider = await t.call(autor, 'POST', '/api/assign', { id, userId: ID.obcy });
    assert.equal(outsider.status, 400);
    assert.match(outsider.json.error, /nie ma dostępu do forum/);
    assert.equal((await t.call(autor, 'POST', '/api/assign', { id, userId: 'abc' })).status, 400);
  } finally { await t.close(); }
});

test('termin i pilne: poprawne wartości, czytelny błąd, czyszczenie, brak zmian przy powtórce', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    const c = taskIn(await t.call(s, 'GET', '/api/board'), 'Pomysł C');
    const due = await t.call(s, 'POST', '/api/due', { id: c.id, due: '2026-11-05' });
    assert.equal(due.json.task.due, '2026-11-05');
    const pl = await t.call(s, 'POST', '/api/due', { id: c.id, due: '06.11.2026' });
    assert.equal(pl.json.task.due, '2026-11-06');
    const bad = await t.call(s, 'POST', '/api/due', { id: c.id, due: 'jutro' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Nie rozumiem terminu/);
    assert.equal((await t.call(s, 'POST', '/api/due', { id: c.id, due: 'x'.repeat(11) })).status, 400);
    const board = await t.call(s, 'GET', '/api/board');
    assert.equal(taskIn(board, 'Pomysł C').due, '2026-11-06');
    const clear = await t.call(s, 'POST', '/api/due', { id: c.id, due: '' });
    assert.equal(clear.json.task.due, null);
    const nullDue = await t.call(s, 'POST', '/api/due', { id: c.id, due: null });
    assert.equal(nullDue.json.task.due, null);

    const on = await t.call(s, 'POST', '/api/urgent', { id: c.id, urgent: true });
    assert.equal(on.json.task.urgent, true);
    const edits = t.fake.requestsTo('PATCH', /^\/channels\/\d+\/messages\/\d+$/).length;
    const onAgain = await t.call(s, 'POST', '/api/urgent', { id: c.id, urgent: true });
    assert.equal(onAgain.status, 200);
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\/\d+\/messages\/\d+$/).length, edits, 'powtórka nie edytuje karty');
    assert.equal((await t.call(s, 'POST', '/api/urgent', { id: c.id, urgent: 'tak' })).status, 400);
    const off = await t.call(s, 'POST', '/api/urgent', { id: c.id, urgent: false });
    assert.equal(off.json.task.urgent, false);
    const card = await waitFor(() => cardsIn(t.fake, c.id)[0]);
    assert.deepEqual(card.embeds[0].fields.map((f) => f.name), ['Osoba', 'Oddanie tekstu', 'Publikacja', 'Priorytet']);
  } finally { await t.close(); }
});

test('premia za social na stronie: stan widać dla wszystkich, zgłasza osoba z zadania, zatwierdza zarząd, kwot nigdzie nie ma', async () => {
  const t = await bootWeb({ env: { FINANCE_USER_IDS: ID.szef } });
  try {
    const autor = await t.login(ID.autor);
    const oliwia = await t.login(ID.oliwia);
    const szef = await t.login(ID.szef);
    const board = await t.call(autor, 'GET', '/api/board');
    const a = taskIn(board, 'Recenzja A'); // post Autora
    assert.deepEqual(board.json.tasks.map((x) => x.social), board.json.tasks.map(() => 'none'));
    assert.equal(board.json.me.finance, false);
    assert.equal((await t.call(szef, 'GET', '/api/board')).json.me.finance, true);

    const bad = await t.call(autor, 'POST', '/api/social', { id: a.id, action: 'tak' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Nieprawidłowe: premia za social/, 'zła akcja jest odrzucana już przez serwer, zanim bot sięgnie po post');
    assert.equal((await t.call(autor, 'POST', '/api/social', { id: 'abc', action: 'on' })).status, 400);
    const stranger = await t.call(oliwia, 'POST', '/api/social', { id: a.id, action: 'on' });
    assert.equal(stranger.status, 403);
    assert.match(stranger.json.error, /zgłasza osoba przypisana do zadania/);

    const claimed = await t.call(autor, 'POST', '/api/social', { id: a.id, action: 'on' });
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(claimed.json.task.social, 'claimed');
    assert.deepEqual(Object.keys(claimed.json.task).sort(), ['assigneeId', 'due', 'id', 'name', 'pubDue', 'social', 'status', 'urgent', 'url'], 'odpowiedź na akcję ma te same pola co tablica, bez kwot');
    assert.equal(taskIn(await t.call(oliwia, 'GET', '/api/board'), 'Recenzja A').social, 'claimed', 'stan widzą wszyscy');
    const card = await waitFor(() => cardsIn(t.fake, a.id)[0]);
    assert.match(card.embeds[0].fields.find((f) => f.name === 'Premia za social').value, /zgłoszona/);

    assert.equal((await t.call(autor, 'POST', '/api/social', { id: a.id, action: 'ok' })).status, 403);
    const noAmount = await t.call(szef, 'POST', '/api/social', { id: a.id, action: 'ok' });
    assert.equal(noAmount.status, 400);
    assert.match(noAmount.json.error, /Najpierw ustaw kwotę premii za social/);

    await t.fake.command(ID.szef, 'rozliczenia', [{ name: 'social', type: 1, options: [{ name: 'kwota', type: 3, value: '20' }] }]);
    const ok = await t.call(szef, 'POST', '/api/social', { id: a.id, action: 'ok' });
    assert.equal(ok.json.task.social, 'ok');
    assert.equal((await t.call(autor, 'POST', '/api/social', { id: a.id, action: 'off' })).status, 403, 'zatwierdzoną premię usuwa tylko zarząd');
    const final = await t.call(autor, 'GET', '/api/board');
    assert.doesNotMatch(JSON.stringify([ok.json, final.json]), /\d,\d\d|zł|"amount"/i, 'strona zna stan premii, ale nie kwotę');
    const off = await t.call(szef, 'POST', '/api/social', { id: a.id, action: 'off' });
    assert.equal(off.json.task.social, 'none');
  } finally { await t.close(); }
});

test('nowe zadanie ze strony: post na forum z tagiem, kartą, osobą i terminem; ten sam tytuł, opis i limity', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    const r = await t.call(s, 'POST', '/api/task', { title: '  Test ze strony  ', userId: ID.oliwia, due: '2026-11-05', pubDue: '12.11.2026', description: 'Źródła w wątku' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.task.name, 'Test ze strony', 'tytuł jest przycięty');
    assert.equal(r.json.task.status, 'Przydzielone');
    assert.equal(r.json.task.assigneeId, ID.oliwia);
    assert.equal(r.json.task.due, '2026-11-05');
    assert.equal(r.json.task.pubDue, '2026-11-12');
    const { body } = t.fake.created[0];
    assert.deepEqual(body.applied_tags, [tagId('Przydzielone')]);
    assert.equal(body.message.content, 'Źródła w wątku');
    assert.deepEqual(body.message.allowed_mentions, { parse: [] });
    const card = await waitFor(() => cardsIn(t.fake, r.json.task.id)[0]);
    assert.deepEqual(card.embeds[0].fields.map((f) => f.value), [`<@${ID.oliwia}>`, '05.11.2026', '12.11.2026', 'zwykły']);
    assert.equal((await t.call(s, 'POST', '/api/task', { title: '   ' })).status, 400);
    assert.equal((await t.call(s, 'POST', '/api/task', { title: 'x'.repeat(101) })).status, 400);
    assert.equal((await t.call(s, 'POST', '/api/task', { title: 'ok', description: 'x'.repeat(1501) })).status, 400);
    assert.equal((await t.call(s, 'POST', '/api/task', { title: 'ok', due: 'dziwne' })).status, 400);
    const badPub = await t.call(s, 'POST', '/api/task', { title: 'ok', pubDue: 'premiera' });
    assert.equal(badPub.status, 400);
    assert.match(badPub.json.error, /Nie rozumiem terminu publikacji/);
    assert.equal(t.fake.created.length, 1, 'błędne zapytania nie tworzą postów');
    const stranger = await t.call(s, 'POST', '/api/task', { title: 'ok', userId: ID.obcy });
    assert.equal(stranger.status, 400);
    assert.equal(t.fake.created.length, 1);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- uprawnienia
test('osoba, której zabrano rolę Redakcja, traci dostęp po odświeżeniu uprawnień (najpóźniej po 30 s)', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 200);
    const original = t.fake.member.bind(t.fake);
    t.fake.member = (id) => (id === ID.autor ? { ...original(ID.obcy), user: t.fake.user(ID.autor, 'u1001') } : original(id));
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 200, 'w ciągu 30 s używamy zapamiętanych uprawnień');
    t.app.bot.web.forget();
    const r = await t.call(s, 'GET', '/api/board');
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'Ta funkcja jest tylko dla redakcji.');
    const w = await t.call(s, 'POST', '/api/urgent', { id: ID.forum, urgent: true });
    assert.equal(w.status, 403);
  } finally { await t.close(); }
});

test('osoba, która opuściła serwer, nie wykona żadnej akcji mimo ważnej sesji', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.oliwia);
    const original = t.fake.knownUser.bind(t.fake);
    t.fake.knownUser = (id) => id !== ID.oliwia && original(id);
    t.app.bot.web.forget();
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 403);
  } finally { await t.close(); }
});

test('sesje wygasają po SESSION_HOURS', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    for (const v of t.site.sessions.values()) v.exp = Date.now() - 1;
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 401);
    assert.equal(t.site.sessions.size, 0);
  } finally { await t.close(); }
});

test('ograniczenie liczby zapytań na sesję', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    let last = 200;
    for (let i = 0; i < 245 && last !== 429; i += 1) last = (await t.call(s, 'GET', '/api/people')).status;
    assert.equal(last, 429);
    const other = await t.login(ID.szef);
    assert.equal((await t.call(other, 'GET', '/api/board')).status, 200, 'inna sesja nie jest blokowana');
  } finally { await t.close(); }
});

test('ograniczenie prób logowania na adres (z TRUST_PROXY liczy się adres klienta z nagłówka)', async () => {
  const t = await bootWeb({ env: { TRUST_PROXY: '1' } });
  try {
    let last = 0;
    for (let i = 0; i < 35 && last !== 429; i += 1) last = (await t.call(null, 'POST', '/api/token', { code: 'zly' }, { 'CF-Connecting-IP': '203.0.113.7' })).status;
    assert.equal(last, 429);
    const other = await t.call(null, 'POST', '/api/token', { code: 'zly' }, { 'CF-Connecting-IP': '203.0.113.8' });
    assert.equal(other.status, 401, 'inny adres ma własny limit');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- logowanie w przeglądarce
test('przeglądarka: przekierowanie do Discorda, kontrola stanu, ciasteczko sesji, odwołanie tokenu, ochrona przed CSRF', async () => {
  const t = await bootWeb();
  try {
    const start = await t.call(null, 'GET', '/auth/login');
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get('location'));
    assert.equal(`${loc.origin}${loc.pathname}`, 'https://discord.com/oauth2/authorize');
    assert.equal(loc.searchParams.get('client_id'), ID.app);
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://tablica.test/auth/callback');
    assert.equal(loc.searchParams.get('scope'), 'identify guilds.members.read');
    assert.equal(loc.searchParams.get('prompt'), 'none');
    const state = loc.searchParams.get('state');
    assert.match(state, /^[A-Za-z0-9_-]{40,}$/);
    const stateCookie = start.headers.get('set-cookie');
    assert.match(stateCookie, new RegExp(`^gb_oauth=${state}; Path=/auth; HttpOnly; SameSite=Lax; Secure; Max-Age=600$`));
    const consent = new URL((await t.call(null, 'GET', '/auth/login?consent=1')).headers.get('location'));
    assert.equal(consent.searchParams.get('prompt'), null, 'z consent=1 Discord pokaże okno zgody');

    const cookie = `gb_oauth=${state}`;
    const wrong = await t.call(null, 'GET', `/auth/callback?code=code-${ID.autor}&state=inny`, undefined, { Cookie: cookie });
    assert.equal(wrong.headers.get('location'), '/?blad=stan');
    const noCookie = await t.call(null, 'GET', `/auth/callback?code=code-${ID.autor}&state=${state}`);
    assert.equal(noCookie.headers.get('location'), '/?blad=stan');
    const needConsent = await t.call(null, 'GET', '/auth/callback?error=consent_required', undefined, { Cookie: cookie });
    assert.equal(needConsent.headers.get('location'), '/auth/login?consent=1');
    const denied = await t.call(null, 'GET', '/auth/callback?error=access_denied', undefined, { Cookie: cookie });
    assert.equal(denied.headers.get('location'), '/?blad=odmowa');
    assert.equal(t.site.sessions.size, 0);

    const stranger = await t.call(null, 'GET', `/auth/callback?code=code-${ID.obcy}&state=${state}`, undefined, { Cookie: cookie });
    assert.equal(stranger.headers.get('location'), '/?blad=dostep');
    assert.equal(t.site.sessions.size, 0);

    const good = await t.call(null, 'GET', `/auth/callback?code=code-${ID.autor}&state=${state}`, undefined, { Cookie: cookie });
    assert.equal(good.status, 302);
    assert.equal(good.headers.get('location'), '/');
    const setCookies = good.headers.getSetCookie();
    const sess = setCookies.find((c) => c.startsWith('gb_sess='));
    assert.match(sess, /^gb_sess=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800$/);
    assert.ok(setCookies.some((c) => c.startsWith('gb_oauth=; ') && /Max-Age=0/.test(c)), 'ciasteczko stanu jest czyszczone');
    const redirectSent = t.oauth.requests.filter((r) => r.path === '/oauth2/token').pop().form.redirect_uri;
    assert.equal(redirectSent, 'https://tablica.test/auth/callback');
    await waitFor(() => t.oauth.revoked.length >= 2);
    assert.ok(t.oauth.revoked.includes(`tok-${ID.autor}`), 'token użytkownika jest odwołany po ustaleniu, kim jest');

    const sessionCookie = sess.split(';')[0];
    assert.equal((await t.call(null, 'GET', '/api/board', undefined, { Cookie: sessionCookie })).status, 200);
    const c = taskIn(await t.call(null, 'GET', '/api/board', undefined, { Cookie: sessionCookie }), 'Pomysł C');
    const post = (extra) => t.call(null, 'POST', '/api/urgent', { id: c.id, urgent: true }, { Cookie: sessionCookie, ...extra });
    assert.equal((await post({})).status, 403, 'zmiana z ciasteczkiem bez nagłówka Origin');
    assert.equal((await post({ Origin: 'https://zla.example' })).status, 403, 'zmiana z obcej strony');
    assert.equal((await post({ Origin: 'https://tablica.test' })).status, 200, 'zmiana z naszej strony');
    assert.equal((await t.call(null, 'POST', '/api/logout', {}, { Cookie: sessionCookie })).status, 403, 'wylogowanie też wymaga Origin');
  } finally { await t.close(); }
});

test('limit prób logowania w przeglądarce odsyła na ekran logowania z komunikatem, a inny adres ma własny limit', async () => {
  const t = await bootWeb({ env: { TRUST_PROXY: '1' } });
  try {
    const ip = (addr) => ({ 'CF-Connecting-IP': addr });
    let last;
    for (let i = 0; i < 40; i += 1) last = await t.call(null, 'GET', '/auth/login', undefined, ip('203.0.113.9'));
    assert.equal(last.status, 302);
    assert.match(last.headers.get('location'), /authorize/, 'czterdziesta próba jeszcze przechodzi');
    const over = await t.call(null, 'GET', '/auth/login', undefined, ip('203.0.113.9'));
    assert.equal(over.status, 302);
    assert.equal(over.headers.get('location'), '/?blad=limit');
    assert.equal(over.headers.get('set-cookie'), null, 'po odmowie nie powstaje ciasteczko stanu');
    const calm = await t.call(null, 'GET', '/auth/login', undefined, ip('203.0.113.10'));
    assert.match(calm.headers.get('location'), /authorize/, 'inny adres ma własny limit');
    const cb = await t.call(null, 'GET', '/auth/callback?code=x&state=y', undefined, ip('203.0.113.9'));
    assert.equal(cb.headers.get('location'), '/?blad=limit', 'callback z tego samego adresu też wraca z komunikatem o limicie');
  } finally { await t.close(); }
});

test('bez PUBLIC_URL logowanie w przeglądarce jest wyłączone, ale Activity działa', async () => {
  const t = await bootWeb({ env: { PUBLIC_URL: '' } });
  try {
    assert.equal((await t.call(null, 'GET', '/auth/login')).status, 404);
    assert.equal((await t.call(null, 'GET', '/api/config')).json.web, false);
    const s = await t.login(ID.autor);
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 200);
    // bez adresu strony ciasteczko nie ma znaczenia, a zmiany z ciasteczkiem są odrzucane
    const fakeCookie = `gb_sess=${s}`;
    const r = await t.call(null, 'POST', '/api/urgent', { id: ID.forum, urgent: true }, { Cookie: fakeCookie, Origin: 'https://tablica.test' });
    assert.equal(r.status, 403);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- pliki statyczne i nagłówki
test('pliki statyczne: tylko z katalogu strony, nagłówki bezpieczeństwa, przedrostek /.proxy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-public-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(path.join(pub, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(pub, 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(pub, '.sekret'), 'tajne');
  fs.writeFileSync(path.join(dir, 'poza.txt'), 'poza katalogiem');
  const t = await bootWeb({ publicDir: pub });
  try {
    const root = await t.call(null, 'GET', '/');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /^text\/html/);
    const csp = root.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.match(csp, /frame-ancestors [^;]*discordsays\.com/);
    assert.equal(root.headers.get('x-frame-options'), null, 'X-Frame-Options zablokowałby Activity');
    assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(root.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await t.call(null, 'GET', '/index.html')).status, 200);
    const js = await t.call(null, 'GET', '/app.js');
    assert.match(js.headers.get('content-type'), /^text\/javascript/);
    assert.equal(js.headers.get('content-security-policy'), null, 'CSP tylko na stronie HTML');
    assert.equal((await t.call(null, 'GET', '/.proxy/app.js')).status, 200);
    assert.equal((await t.call(null, 'GET', '/.proxy/api/config')).status, 200);

    // fetch() sam "naprawia" ścieżki typu /../, więc wysyłamy surowe żądania: serwer widzi dokładnie ten adres.
    const raw = (p) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.port, path: p, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    const probes = {
      '/..%2fpoza.txt': 404, '/%2e%2e/poza.txt': 404, '/../poza.txt': 404, '/sub/../../poza.txt': 404, '/.sekret': 404, '/.%73ekret': 404,
      '/sub/': 404, '/sub': 404, '/nie-ma.js': 404, '//poza.txt': 400, '//': 400, '/app.js/..%2f..%2fpoza.txt': 404, '/%00': 404, '/app.js%00.png': 404,
      '/\\..\\poza.txt': 400, // ukośnik wsteczny w adresie jest odrzucany od razu (przeglądarki traktują go jak /)
    };
    for (const [bad, want] of Object.entries(probes)) {
      const r = await raw(bad);
      assert.equal(r.status, want, `${bad} -> ${r.status}`);
      assert.doesNotMatch(r.body, /poza katalogiem|tajne/, bad);
    }
    // Kontrola: zwykła ścieżka przez to samo surowe żądanie działa, więc powyższe 404 nie są skutkiem błędu testu.
    assert.equal((await raw('/app.js')).status, 200);
    assert.equal((await t.call(null, 'POST', '/', {})).status, 405);
    assert.equal((await t.call(null, 'GET', '/healthz')).text, 'ok');

    const etag = js.headers.get('etag');
    assert.equal((await t.call(null, 'GET', '/app.js', undefined, { 'If-None-Match': etag })).status, 304);
    const head = await fetch(`${t.base}/app.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('błędy serwera nie ujawniają szczegółów, a nieznane trasy dają 404', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    t.fake.failures.push({ re: /GET \/guilds\/\d+\/threads\/active/, status: 500 });
    t.fake.failures.push({ re: /GET \/guilds\/\d+\/threads\/active/, status: 500 });
    t.fake.failures.push({ re: /GET \/guilds\/\d+\/threads\/active/, status: 500 });
    t.fake.failures.push({ re: /GET \/guilds\/\d+\/threads\/active/, status: 500 });
    t.fake.failures.push({ re: /GET \/guilds\/\d+\/threads\/active/, status: 500 });
    const r = await t.call(s, 'GET', '/api/board');
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'Coś poszło nie tak. Spróbuj za chwilę, a jeśli się powtórzy, zgłoś to osobie, która obsługuje bota.');
    assert.doesNotMatch(r.text, /Fake failure|threads|stack/i);
    assert.equal((await t.call(s, 'GET', '/api/board')).status, 200, 'po błędzie następne zapytanie próbuje od nowa');
    assert.equal((await t.call(s, 'GET', '/api/nie-ma')).status, 404);
    assert.equal((await t.call(s, 'POST', '/api/nie-ma', {})).status, 404);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- przyciski na tablicy w Discordzie
test('nagłówek żywej tablicy: przycisk Activity i link do strony tylko po włączeniu w ustawieniach', async () => {
  const t = await bootWeb({ env: { ACTIVITY: '1' } });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const header = () => t.fake.messagesOf(ID.ogolne).find((m) => m.embeds[0] && m.embeds[0].title === 'Tablica redakcji' && m.components.length);
    const row = header().components[0].components;
    assert.deepEqual(row.map((c) => c.label), ['Dodaj zadanie', 'Tablica z przeciąganiem', 'W przeglądarce']);
    assert.equal(row[1].custom_id, 'kb:activity');
    assert.equal(row[2].style, 5);
    assert.equal(row[2].url, 'https://tablica.test');
    assert.equal(header().components[1].components[0].custom_id, 'kb:filter');

    const launched = await t.fake.component(ID.autor, ID.ogolne, 'kb:activity', { type: 2 });
    assert.equal(launched[0].kind, 'callback');
    assert.equal(launched[0].type, 12, 'odpowiedź "uruchom Activity"');
    const denied = await t.fake.component(ID.obcy, ID.ogolne, 'kb:activity', { type: 2 });
    assert.equal(denied[0].data.content, 'Ta funkcja jest tylko dla redakcji.');
    assert.notEqual(denied[0].type, 12);

    t.fake.failures.push({ re: /POST \/interactions\/\d+\/[^/]+\/callback/, status: 400, code: 40000 });
    const failed = await t.fake.component(ID.autor, ID.ogolne, 'kb:activity', { type: 2 });
    assert.match(failed[0].data.content, /Discord nie uruchomił Activity/);
    assert.match(failed[0].data.content, /https:\/\/tablica\.test/);
  } finally { await t.close(); }
});

test('bez ACTIVITY nagłówek ma tylko link do strony', async () => {
  const t = await bootWeb();
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const header = t.fake.messagesOf(ID.ogolne).find((m) => m.embeds[0] && m.embeds[0].title === 'Tablica redakcji' && m.components.length);
    assert.deepEqual(header.components[0].components.map((c) => c.label), ['Dodaj zadanie', 'Tablica z przeciąganiem']);
    assert.equal(header.components[0].components[1].url, 'https://tablica.test');
  } finally { await t.close(); }
});

test('osoby korzystające z bota trafiają na listę do przydziału, a nie-redakcja nie', async () => {
  const t = await bootWeb({ seedFn: (fake) => { fake.addThread({ name: 'Zadanie', owner: ID.app, status: 'Pomysł', content: '' }); } });
  try {
    const before = await t.call(await t.login(ID.autor), 'GET', '/api/people');
    assert.deepEqual(before.json.people.map((p) => p.id), [ID.autor]);
    await t.fake.command(ID.oliwia, 'tablica');
    await t.fake.command(ID.obcy, 'tablica', [], ID.pogaduszki);
    t.app.bot.web.forget();
    const after = await t.call(await t.login(ID.autor), 'GET', '/api/people');
    assert.deepEqual(after.json.people.map((p) => p.id).sort(), [ID.autor, ID.oliwia].sort());
    assert.deepEqual(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).people.sort(), [ID.autor, ID.oliwia].sort(), 'zapisane są same numery');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- poprawki po przeglądzie bezpieczeństwa
const rawGet = (port, requestLine, headers = []) => new Promise((resolve, reject) => {
  const s = require('node:net').connect(port, '127.0.0.1');
  let buf = '';
  s.on('data', (d) => { buf += d.toString('latin1'); });
  s.on('error', reject);
  s.on('close', () => resolve(buf));
  s.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}\r\n`);
});
const statusOf = (raw) => Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]);

test('limity zapytań: bez TRUST_PROXY nagłówki od serwera pośredniczącego nic nie zmieniają, więc nie da się ich podrobić', async () => {
  const t = await bootWeb();
  try {
    let last = 0;
    for (let i = 0; i < 35 && last !== 429; i += 1) last = (await t.call(null, 'POST', '/api/token', { code: 'zly' }, { 'CF-Connecting-IP': `203.0.113.${i + 1}` })).status;
    assert.equal(last, 429, 'zmiana nagłówka nie daje nowego limitu');
  } finally { await t.close(); }
});

test('limity zapytań z TRUST_PROXY: śmieci w nagłówku nie są kluczem, X-Forwarded-For liczy się od prawej, IPv6 po prefiksie /64', async () => {
  const t = await bootWeb({ env: { TRUST_PROXY: '1' } });
  try {
    const burst = async (headerFor) => {
      let last = 0;
      for (let i = 0; i < 35 && last !== 429; i += 1) last = (await t.call(null, 'POST', '/api/token', { code: 'zly' }, headerFor(i))).status;
      return last;
    };
    assert.equal(await burst((i) => ({ 'CF-Connecting-IP': `nie-adres-${i}` })), 429, 'tekst zamiast adresu wraca do adresu połączenia');
    assert.equal(await burst((i) => ({ 'X-Forwarded-For': `1.1.1.${i + 1}, 198.51.100.4` })), 429, 'pierwszy wpis XFF podaje klient, liczy się ostatni');
    assert.equal(await burst((i) => ({ 'CF-Connecting-IP': `2001:db8:5:6:${(i + 1).toString(16)}::1` })), 429, 'adresy z jednej sieci /64 dzielą limit');
    const other = await t.call(null, 'POST', '/api/token', { code: 'zly' }, { 'CF-Connecting-IP': '198.51.100.77' });
    assert.equal(other.status, 401, 'zwykły inny adres ma własny limit');
  } finally { await t.close(); }
});

test('limity zapytań za bramą Railway (PROXY_TYPE=railway): liczy się X-Real-IP, a nagłówka Cloudflare nie da się użyć do obejścia limitu', async () => {
  const t = await bootWeb({ env: { TRUST_PROXY: '1', PROXY_TYPE: 'railway' } });
  try {
    const burst = async (headerFor) => {
      let last = 0;
      for (let i = 0; i < 35 && last !== 429; i += 1) last = (await t.call(null, 'POST', '/api/token', { code: 'zly' }, headerFor(i))).status;
      return last;
    };
    assert.equal(await burst((i) => ({ 'CF-Connecting-IP': `203.0.113.${i + 1}` })), 429, 'podrobiony CF-Connecting-IP nie daje nowego limitu');
    assert.equal(await burst((i) => ({ 'X-Real-IP': `nie-adres-${i}` })), 429, 'tekst zamiast adresu wraca do adresu połączenia');
    assert.equal(await burst(() => ({ 'X-Forwarded-For': '1.1.1.1, 198.51.100.4' })), 429, 'bez X-Real-IP liczy się ostatni wpis X-Forwarded-For');
    assert.notEqual(await burst((i) => ({ 'X-Real-IP': `198.51.100.${i + 10}` })), 429, 'różni klienci według X-Real-IP mają osobne limity');
    const other = await t.call(null, 'POST', '/api/token', { code: 'zly' }, { 'X-Real-IP': '198.51.100.200' });
    assert.equal(other.status, 401, 'nowy adres ma własny limit');
  } finally { await t.close(); }
});

test('limity zapytań w trybie Cloudflare (domyślnym) nie ufają X-Real-IP, więc nie da się go podrobić', async () => {
  const t = await bootWeb({ env: { TRUST_PROXY: '1' } });
  try {
    let last = 0;
    for (let i = 0; i < 35 && last !== 429; i += 1) last = (await t.call(null, 'POST', '/api/token', { code: 'zly' }, { 'X-Real-IP': `203.0.113.${i + 1}` })).status;
    assert.equal(last, 429);
  } finally { await t.close(); }
});

test('config: port z PORT (hosting) i HTTP_PORT, typ serwera pośredniczącego, stan początkowy z base64', () => {
  const OK = { DISCORD_TOKEN: 'abc.def', GUILD_ID: '123456789012345678' };
  assert.equal(loadConfig(OK).web.port, 8080);
  assert.equal(loadConfig({ ...OK, PORT: '3000' }).web.port, 3000, 'Railway podaje port w PORT');
  assert.equal(loadConfig({ ...OK, PORT: '3000', HTTP_PORT: '9000' }).web.port, 9000, 'HTTP_PORT ma pierwszeństwo');
  for (const bad of [{ PORT: 'abc' }, { PORT: '70000' }, { PORT: '0' }, { HTTP_PORT: '80x' }]) assert.throws(() => loadConfig({ ...OK, ...bad }), /numer portu/, JSON.stringify(bad));
  assert.equal(loadConfig(OK).web.proxyType, 'cloudflare');
  assert.equal(loadConfig({ ...OK, PROXY_TYPE: 'Railway' }).web.proxyType, 'railway');
  assert.throws(() => loadConfig({ ...OK, PROXY_TYPE: 'nginx' }), /PROXY_TYPE/);
  assert.equal(loadConfig(OK).stateSeed, null);
  const state = { tasks: { 1: { a: '2', d: '2026-11-05' } }, lastDigest: '2026-10-23' };
  const b64 = Buffer.from(JSON.stringify(state)).toString('base64');
  assert.deepEqual(loadConfig({ ...OK, STATE_SEED_B64: `${b64}\r\n` }).stateSeed, state, 'koniec linii po skopiowaniu nie przeszkadza');
  for (const bad of ['!!!', Buffer.from('[1,2]').toString('base64'), Buffer.from('nie json').toString('base64'), Buffer.from('null').toString('base64')]) {
    assert.throws(() => loadConfig({ ...OK, STATE_SEED_B64: bad }), /STATE_SEED_B64/, bad);
  }
});

test('wymiana kodu: zły format nie kosztuje zapytania do Discorda, a łączny budżet chroni limity Discorda przed zalewem z wielu adresów', async () => {
  const t = await bootWeb({ env: { TRUST_PROXY: '1' } });
  try {
    const before = t.oauth.requests.length;
    for (const code of ['<script>', 'a b', 'x'.repeat(301), 'ż']) {
      const r = await t.call(null, 'POST', '/api/token', { code });
      assert.equal(r.status, 400, `kod ${JSON.stringify(code).slice(0, 20)}`);
    }
    assert.equal(t.oauth.requests.length, before, 'Discord nie dostał żadnego zapytania');
    let last = 0;
    let n = 0;
    for (; n < 130 && last !== 429; n += 1) last = (await t.call(null, 'POST', '/api/token', { code: 'zly' }, { 'CF-Connecting-IP': `198.51.${Math.floor(n / 200)}.${(n % 200) + 1}` })).status;
    assert.equal(last, 429, 'po wyczerpaniu wspólnego budżetu nawet nowy adres dostaje odmowę');
    assert.ok(n > 100 && n <= 125, `budżet wynosi około 120 prób, odmowa przyszła po ${n}`);
  } finally { await t.close(); }
});

test('callback logowania: stan z nie-ASCII w ciasteczku nie wywala serwera, tylko wraca z komunikatem', async () => {
  const t = await bootWeb();
  try {
    const r = await t.call(null, 'GET', `/auth/callback?code=code-${ID.autor}&state=%C3%A9`, undefined, { Cookie: 'gb_oauth=a' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/?blad=stan');
    const bad = await t.call(null, 'GET', '/auth/callback?code=%3Cx%3E&state=abc', undefined, { Cookie: 'gb_oauth=abc' });
    assert.equal(bad.headers.get('location'), '/?blad=logowanie', 'kod w złym formacie');
    assert.equal(t.site.sessions.size, 0);
  } finally { await t.close(); }
});

test('adres ze znakiem \\ (przeglądarki zamieniają go na /) jest odrzucany, zwykłe ścieżki działają', async () => {
  const t = await bootWeb();
  try {
    assert.equal(statusOf(await rawGet(t.port, 'GET /\\evil.example/healthz HTTP/1.1')), 400);
    assert.equal(statusOf(await rawGet(t.port, 'GET /%5Cevil.example/healthz HTTP/1.1')), 404, 'zakodowany ukośnik to zwykła (nieistniejąca) nazwa pliku');
    assert.equal(statusOf(await rawGet(t.port, 'GET /healthz HTTP/1.1')), 200);
  } finally { await t.close(); }
});

test('termin: brak pola nie kasuje terminu, a zapis tej samej wartości nie rusza Discorda', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    const id = taskIn(await t.call(s, 'GET', '/api/board'), 'Recenzja A').id;
    const set = await t.call(s, 'POST', '/api/due', { id, due: '2026-11-05' });
    assert.equal(set.status, 200);
    assert.equal(set.json.task.due, '2026-11-05');
    const missing = await t.call(s, 'POST', '/api/due', { id });
    assert.equal(missing.status, 400);
    assert.equal(taskIn(await t.call(s, 'GET', '/api/board'), 'Recenzja A').due, '2026-11-05', 'termin został');
    assert.equal((await t.call(s, 'POST', '/api/due', { id, due: 5 })).status, 400, 'liczba zamiast tekstu');
    const rev = t.app.bot.web.revision();
    const edits = t.fake.requestsTo('PATCH', /^\/channels\/\d+\/messages\/\d+$/).length;
    const same = await t.call(s, 'POST', '/api/due', { id, due: '2026-11-05' });
    assert.equal(same.status, 200);
    assert.equal(t.app.bot.web.revision(), rev, 'bez zmiany tablica się nie przebudowuje');
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\/\d+\/messages\/\d+$/).length, edits, 'bez zmiany karta nie jest edytowana');
    const clear = await t.call(s, 'POST', '/api/due', { id, due: null });
    assert.equal(clear.status, 200);
    assert.equal(clear.json.task.due, null);
  } finally { await t.close(); }
});

test('dwa terminy ze strony: oddanie i publikacja osobno albo razem, brak pola zostawia drugi termin, powtórka nie rusza Discorda', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    const id = taskIn(await t.call(s, 'GET', '/api/board'), 'Recenzja A').id;
    const both = await t.call(s, 'POST', '/api/due', { id, due: '2026-11-05', pubDue: '2026-11-12' });
    assert.equal(both.status, 200, both.text);
    assert.deepEqual([both.json.task.due, both.json.task.pubDue], ['2026-11-05', '2026-11-12']);
    const onlyPub = await t.call(s, 'POST', '/api/due', { id, pubDue: '13.11.2026' });
    assert.deepEqual([onlyPub.json.task.due, onlyPub.json.task.pubDue], ['2026-11-05', '2026-11-13'], 'sama publikacja nie rusza oddania');
    const onlyDue = await t.call(s, 'POST', '/api/due', { id, due: '06.11.2026' });
    assert.deepEqual([onlyDue.json.task.due, onlyDue.json.task.pubDue], ['2026-11-06', '2026-11-13'], 'samo oddanie nie rusza publikacji');
    const board = taskIn(await t.call(s, 'GET', '/api/board'), 'Recenzja A');
    assert.deepEqual([board.due, board.pubDue], ['2026-11-06', '2026-11-13']);
    const card = await waitFor(() => cardsIn(t.fake, id).find((m) => m.embeds[0].fields[2].value === '13.11.2026'));
    assert.deepEqual(card.embeds[0].fields.slice(1, 3).map((f) => f.value), ['06.11.2026', '13.11.2026']);

    const bad = await t.call(s, 'POST', '/api/due', { id, pubDue: 'premiera' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Nie rozumiem terminu publikacji/);
    const mixed = await t.call(s, 'POST', '/api/due', { id, due: '2026-12-01', pubDue: 'zły' });
    assert.equal(mixed.status, 400);
    assert.equal(taskIn(await t.call(s, 'GET', '/api/board'), 'Recenzja A').due, '2026-11-06', 'błąd w jednym polu nie zapisuje drugiego');
    assert.equal((await t.call(s, 'POST', '/api/due', { id })).status, 400, 'bez żadnego pola');
    assert.equal((await t.call(s, 'POST', '/api/due', { id, pubDue: 7 })).status, 400, 'liczba zamiast tekstu');
    assert.equal((await t.call(s, 'POST', '/api/due', { id, pubDue: 'x'.repeat(11) })).status, 400);

    const rev = t.app.bot.web.revision();
    const edits = t.fake.requestsTo('PATCH', /^\/channels\/\d+\/messages\/\d+$/).length;
    const same = await t.call(s, 'POST', '/api/due', { id, due: '2026-11-06', pubDue: '2026-11-13' });
    assert.equal(same.status, 200);
    assert.equal(t.app.bot.web.revision(), rev, 'bez zmiany tablica się nie przebudowuje');
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\/\d+\/messages\/\d+$/).length, edits, 'bez zmiany karta nie jest edytowana');

    const clear = await t.call(s, 'POST', '/api/due', { id, pubDue: null });
    assert.deepEqual([clear.json.task.due, clear.json.task.pubDue], ['2026-11-06', null], 'usunięcie publikacji zostawia oddanie');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[id].p, undefined, 'w stanie nie zostaje pusty klucz');
  } finally { await t.close(); }
});

test('ETag: słaby walidator i lista wartości od serwera pośredniczącego też dają 304', async () => {
  const t = await bootWeb();
  try {
    const s = await t.login(ID.autor);
    const first = await t.call(s, 'GET', '/api/board');
    const etag = first.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{40}"$/);
    for (const header of [etag, `W/${etag}`, `"inny", W/${etag}`, '*']) {
      assert.equal((await t.call(s, 'GET', '/api/board', undefined, { 'If-None-Match': header })).status, 304, header);
    }
    assert.equal((await t.call(s, 'GET', '/api/board', undefined, { 'If-None-Match': '"inny"' })).status, 200);
    const page = await t.call(null, 'GET', '/');
    const pageTag = page.headers.get('etag');
    if (pageTag) assert.equal((await t.call(null, 'GET', '/', undefined, { 'If-None-Match': `W/${pageTag.replace(/^W\//, '')}` })).status, 304);
  } finally { await t.close(); }
});

test('CSP pozwala osadzać stronę tylko w Discordzie i pod domeną tej aplikacji', async () => {
  const t = await bootWeb();
  try {
    const csp = (await t.call(null, 'GET', '/')).headers.get('content-security-policy');
    const fa = /frame-ancestors ([^;]*)/.exec(csp)[1];
    assert.equal(fa, `'self' https://discord.com https://*.discord.com https://${ID.app}.discordsays.com`);
  } finally { await t.close(); }
});

test('plik statyczny: zerwane przez klienta pobranie nie zostawia otwartych deskryptorów', { skip: !require('node:fs').existsSync('/proc/self/fd') }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-fd-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(dir, 'duzy.js'), Buffer.alloc(8 * 1024 * 1024, 97));
  const t = await bootWeb({ publicDir: dir });
  try {
    const net = require('node:net');
    const fdCount = () => fs.readdirSync('/proc/self/fd').length;
    const abort = () => new Promise((resolve) => {
      const s = net.connect(t.port, '127.0.0.1', () => s.write('GET /duzy.js HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.once('data', () => { s.destroy(); resolve(); });
      s.on('error', () => resolve());
    });
    await abort(); await sleep(100);
    const before = fdCount();
    for (let i = 0; i < 60; i += 1) await abort();
    await sleep(500);
    const grew = fdCount() - before;
    assert.ok(grew < 15, `po 60 zerwanych pobraniach przybyło ${grew} deskryptorów`);
    const ok = await t.call(null, 'GET', '/duzy.js');
    assert.equal(ok.status, 200, 'serwer nadal działa');
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.env.example po uzupełnieniu tokenu i numeru serwera daje poprawną konfigurację (strona wyłączona, dopóki nie ma sekretu)', () => {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  const base = loadConfig({ ...env, DISCORD_TOKEN: 'x.y.z', GUILD_ID: '123456789012345678' });
  assert.equal(base.web.enabled, false);
  assert.equal(base.web.trustProxy, true, 'domyślnie za tunelem');
  const full = loadConfig({ ...env, DISCORD_TOKEN: 'x.y.z', GUILD_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 's', PUBLIC_URL: 'https://tablica.gameby.pl', ACTIVITY: '1' });
  assert.equal(full.web.enabled, true);
  assert.equal(full.web.publicUrl, 'https://tablica.gameby.pl');
  assert.equal(full.web.activity, true);
});
