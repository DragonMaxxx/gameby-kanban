'use strict';
// Autor: Mateusz Bartoszewicz
// Rozliczenia end-to-end: prawdziwy discord.js rozmawia z fałszywym Discordem (komendy, wiadomości prywatne z PDF, przyciski w rozmowie).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { boot, opt, EPHEMERAL, ID } = require('./helpers');
const { tagId } = require('./fake-discord');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); }
  return fn();
}
const plain = (s) => String(s).replace(/ /g, ' ');
const editOf = (events) => events.find((e) => e.kind === 'edit')?.body;
const textOf = (events) => plain(editOf(events)?.content ?? events.find((e) => e.kind === 'followup')?.body?.content ?? '');
const sub = (name, ...options) => [{ name, type: 1, options }];
const stateOf = (t) => { try { return JSON.parse(fs.readFileSync(t.stateFile, 'utf8')); } catch { return {}; } }; // plik powstaje przy pierwszym zapisie
const finOf = (t) => stateOf(t).fin;
const metaOf = (t, id) => (stateOf(t).tasks || {})[id];
const flat = (msg) => (msg.components || []).flatMap((r) => r.components);
const DAY = (iso) => new Date(iso);

// Zarząd to ID.szef; piszą ID.oliwia (ze stawką) i ID.autor (bez stawki).
async function setup({ clock = '2026-10-26T10:00:00Z', env = {}, seed } = {}) {
  let current = DAY(clock);
  const t = await boot({
    now: () => current,
    env: { FINANCE_USER_IDS: ID.szef, PROTOCOL_RETURN_EMAIL: 'rozliczenia@gameby.pl', ...env },
    seed,
  });
  t.setNow = (iso) => { current = DAY(iso); };
  t.bot = t.app.bot;
  t.rozl = (user, subcommand, options = [], channel = ID.ogolne) => t.fake.command(user, 'rozliczenia', sub(subcommand, ...options), channel);
  t.rate = async (userId, amount, name) => t.rozl(ID.szef, 'stawka', [opt('osoba', userId, 6), opt('kwota', amount), ...(name ? [opt('imie', name)] : [])]);
  t.handIn = (thread, userId = ID.oliwia) => t.fake.component(userId, thread.id, 'kb:go:Do redakcji', { type: 2 });
  t.dm = (userId) => { const ch = t.fake.dmChannelOf(userId); return ch ? t.fake.messagesOf(ch.id) : []; };
  t.draftMsg = () => [...t.dm(ID.szef)].reverse().find((m) => m.components && m.components.length);
  t.press = (customId, { user = ID.szef, ...o } = {}) => t.fake.dmComponent(user, t.fake.dmChannelOf(ID.szef).id, customId, o);
  t.drafts = () => t.dm(ID.szef).filter((m) => m.components && m.components.length);
  // Nowy szkic po odświeżeniu: poprzedni traci przyciski, więc czekamy na inną wiadomość z przyciskami niż `old`.
  t.newDraftAfter = (old) => waitFor(() => { const d = t.draftMsg(); return d && d.id !== old.id ? d : null; });
  return t;
}

function pdfText(buf) {
  const file = path.join(os.tmpdir(), `kanban-pdf-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, buf);
  try { return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }); } catch { return null; } finally { fs.rmSync(file, { force: true }); }
}

// Dwa teksty Oliwii (5 i 20 października) i jeden Autora (22 października), wszystkie oddane przyciskiem „Oddaj do redakcji”.
async function octoberBoard(t) {
  const a = t.fake.addThread({ name: 'Recenzja A', owner: ID.oliwia, status: 'W pisaniu' });
  const b = t.fake.addThread({ name: 'Poradnik B', owner: ID.oliwia, status: 'W pisaniu' });
  const c = t.fake.addThread({ name: 'News C', owner: ID.autor, status: 'W pisaniu' });
  t.setNow('2026-10-05T10:00:00Z'); await t.handIn(a);
  t.setNow('2026-10-20T10:00:00Z'); await t.handIn(b);
  t.setNow('2026-10-22T10:00:00Z'); await t.handIn(c, ID.autor);
  t.setNow('2026-10-26T10:00:00Z');
  return { a, b, c };
}

// Włączenie rozliczeń w październiku i pierwszy dzień roboczy listopada: bot przygotowuje szkic za październik.
async function draftForOctober(t) {
  await t.bot.financeTick(); // zapisuje początek rozliczeń (październik)
  t.setNow('2026-11-02T08:30:00Z'); // poniedziałek, 09:30 w Warszawie
  await t.bot.financeTick();
}

// ---------------------------------------------------------------- dostęp

test('rozliczenia: bez FINANCE_USER_IDS funkcja jest wyłączona i nic nie zbiera', async () => {
  const t = await setup({ env: { FINANCE_USER_IDS: '' } });
  try {
    const ev = await t.rozl(ID.szef, 'stawka', [opt('osoba', ID.oliwia, 6), opt('kwota', '120')]);
    assert.match(textOf(ev), /Rozliczenia są wyłączone.*FINANCE_USER_IDS/);
    await t.bot.financeTick();
    assert.equal(finOf(t), undefined, 'żadnych danych o rozliczeniach w stanie');
  } finally { await t.close(); }
});

test('rozliczenia: komendy i przyciski działają tylko dla zarządu, odpowiedzi są prywatne', async () => {
  const t = await setup();
  try {
    for (const [name, opts] of [['stawka', [opt('osoba', ID.oliwia, 6), opt('kwota', '120')]], ['stawki', []], ['szkic', []], ['premia', [opt('kwota', '20')]]]) {
      const ev = await t.rozl(ID.autor, name, opts);
      assert.equal(ev[0].data.flags, EPHEMERAL, name);
      assert.match(textOf(ev), /tylko dla zarządu/, name);
    }
    assert.equal(finOf(t), undefined, 'nikt spoza zarządu nie ustawił stawki');
    // przycisk w rozmowie prywatnej klikany przez kogoś spoza zarządu
    await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await draftForOctober(t);
    const ev = await t.press('kb:fin:yes:2026-10', { user: ID.autor });
    assert.match(plain(ev.find((e) => e.kind === 'followup')?.body?.content), /tylko dla zarządu/);
    assert.equal(t.dm(ID.oliwia).length, 0, 'nic nie poszło do osób');
    assert.equal(finOf(t).months['2026-10'].state, 'draft');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- stawki

test('/rozliczenia stawka i stawki: zapis, imię do protokołu, usuwanie, zły format; stawki widzi tylko zarząd', async () => {
  const t = await setup();
  try {
    const ok = await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    assert.match(textOf(ok), /Zapisano: <@\d+> jako „Oliwia Nowak”, 150,00 zł za tekst/);
    assert.deepEqual(finOf(t).rates, { [ID.oliwia]: { name: 'Oliwia Nowak', rate: 15000 } });
    await t.rate(ID.autor, '99,5');
    assert.deepEqual(finOf(t).rates[ID.autor], { name: `u${ID.autor.slice(-4)}`, rate: 9950 });
    const again = await t.rate(ID.oliwia, '160');
    assert.deepEqual(finOf(t).rates[ID.oliwia], { name: 'Oliwia Nowak', rate: 16000 }, 'zmiana stawki zachowuje imię');
    assert.match(textOf(again), /160,00 zł/);
    const list = await t.rozl(ID.szef, 'stawki');
    assert.equal(list[0].data.flags, EPHEMERAL);
    assert.match(textOf(list), /Oliwia Nowak.*160,00 zł za tekst/);
    for (const bad of ['abc', '-5', '12,345', '100000,50']) {
      const ev = await t.rate(ID.oliwia, bad);
      assert.match(textOf(ev), /Nie rozumiem kwoty/, bad);
    }
    assert.equal(finOf(t).rates[ID.oliwia].rate, 16000, 'błędne kwoty niczego nie zmieniają');
    const del = await t.rate(ID.oliwia, 'brak');
    assert.match(textOf(del), /Usunięto stawkę/);
    assert.equal(finOf(t).rates[ID.oliwia], undefined);
    assert.match(textOf(await t.rate(ID.oliwia, 'brak')), /nie ma ustawionej stawki/);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- data oddania do redakcji

test('data oddania: zapisuje się przy przejściu do „Do redakcji”, znika przy powrocie do pisania, ręczna zmiana tagu też się liczy', async () => {
  let manual;
  const t = await setup({ seed: (fake) => { manual = fake.addThread({ name: 'Ręcznie', owner: ID.oliwia, status: 'W pisaniu' }); } });
  try {
    const th = t.fake.addThread({ name: 'Tekst', owner: ID.oliwia, status: 'W pisaniu' });
    assert.equal(metaOf(t, th.id), undefined);
    await t.handIn(th);
    assert.equal(metaOf(t, th.id).h, '2026-10-26');
    // powrót do pisania kasuje datę, kolejne oddanie zapisuje nową
    await t.fake.component(ID.oliwia, th.id, 'kb:go:W pisaniu', { type: 2 });
    assert.equal(metaOf(t, th.id).h, undefined, 'cofnięty tekst nie ma daty oddania');
    t.setNow('2026-10-28T10:00:00Z');
    await t.handIn(th);
    assert.equal(metaOf(t, th.id).h, '2026-10-28');
    // dalsze statusy po oddaniu nie zmieniają daty
    t.setNow('2026-10-30T10:00:00Z');
    await t.fake.component(ID.szef, th.id, 'kb:go:Do publikacji', { type: 2 });
    assert.equal(metaOf(t, th.id).h, '2026-10-28');
    // ręczna zmiana tagu w Discordzie (bez bota): z pisania do redakcji
    t.setNow('2026-10-29T10:00:00Z');
    manual.applied_tags = [tagId('Do redakcji')];
    t.fake.dispatch('THREAD_UPDATE', manual);
    await waitFor(() => metaOf(t, manual.id)?.h);
    assert.equal(metaOf(t, manual.id).h, '2026-10-29');
    // zmiana, która nie rusza statusu (pilne), nie nadaje daty tekstowi, który ma już dawno status końcowy
    const old = t.fake.addThread({ name: 'Stary', owner: ID.oliwia, status: 'Opublikowane' });
    await t.fake.component(ID.oliwia, old.id, 'kb:urgent:on', { type: 2 });
    assert.equal(metaOf(t, old.id).h, undefined, 'stare teksty nie dostają daty „dzisiaj”');
    // zmiana z karty zapisuje datę sama, nie czekając na zdarzenie z Discorda (discord.js potrafi pokazać je już po aktualizacji pamięci podręcznej)
    t.fake.muteThreadUpdates = true;
    const quiet = t.fake.addThread({ name: 'Bez zdarzeń', owner: ID.oliwia, status: 'W pisaniu' });
    t.setNow('2026-10-31T10:00:00Z');
    await t.handIn(quiet);
    assert.equal(metaOf(t, quiet.id).h, '2026-10-31', 'data oddania bez zdarzenia THREAD_UPDATE');
    await t.fake.component(ID.oliwia, quiet.id, 'kb:go:W pisaniu', { type: 2 });
    assert.equal(metaOf(t, quiet.id).h, undefined, 'powrót do pisania bez zdarzenia THREAD_UPDATE');
    t.fake.muteThreadUpdates = false;
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- premie

test('/rozliczenia premia: dopisuje się do tekstu, trafia do miesiąca tekstu, nie widać jej na karcie ani stronie, „brak” usuwa nierozliczone', async () => {
  const t = await setup();
  try {
    const { a } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    t.setNow('2026-10-27T10:00:00Z');
    const ev = await t.rozl(ID.szef, 'premia', [opt('kwota', '20'), opt('opis', 'post na Facebooku')], a.id);
    assert.equal(ev[0].data.flags, EPHEMERAL);
    assert.match(textOf(ev), /Dodano premię 20,00 zł \(post na Facebooku\)\. Trafi do rozliczenia za październik 2026\./);
    const b1 = metaOf(t, a.id).b;
    assert.equal(b1.length, 1);
    assert.deepEqual([b1[0].a, b1[0].n, b1[0].m, b1[0].s], [2000, 'post na Facebooku', '2026-10', undefined]);
    // druga premia do tego samego tekstu
    await t.rozl(ID.szef, 'premia', [opt('kwota', '5,50'), opt('opis', 'Instagram')], a.id);
    assert.equal(metaOf(t, a.id).b.length, 2);
    assert.notEqual(metaOf(t, a.id).b[0].i, metaOf(t, a.id).b[1].i, 'każda premia ma własny numer');
    // nic z tego nie widać na stronie z tablicą ani na karcie
    const snapshot = await t.bot.web.board();
    for (const task of snapshot.tasks) assert.deepEqual(Object.keys(task).sort(), ['assigneeId', 'due', 'id', 'name', 'pubDue', 'social', 'status', 'urgent', 'url']);
    assert.doesNotMatch(JSON.stringify(snapshot), /zł|\d,\d\d|premi|stawk|"(b|h|s|amount|rate)"/i);
    const cards = t.fake.messagesOf(a.id).filter((m) => m.components.length);
    assert.doesNotMatch(JSON.stringify(cards), /zł|\d,\d\d|stawk|kwot/i, 'karta może mieć przycisk premii za social, ale żadnej kwoty');
    // błędne dane i brak uprawnień
    assert.match(textOf(await t.rozl(ID.szef, 'premia', [opt('kwota', 'dużo')], a.id)), /Nie rozumiem kwoty premii/);
    assert.match(textOf(await t.rozl(ID.szef, 'premia', [opt('kwota', '10')], ID.ogolne)), /działają tylko w postach na forum/);
    // usuwanie nierozliczonych
    assert.match(textOf(await t.rozl(ID.szef, 'premia', [opt('kwota', 'brak')], a.id)), /Usunięto 2 premie/);
    assert.equal(metaOf(t, a.id).b, undefined, 'pusta lista premii nie zostaje w stanie');
    assert.match(textOf(await t.rozl(ID.szef, 'premia', [opt('kwota', 'brak')], a.id)), /nie ma nierozliczonych premii/);
  } finally { await t.close(); }
});

test('premia bez osoby albo bez stawki: komunikat ostrzega, że nie wejdzie do protokołu', async () => {
  const t = await setup();
  try {
    const free = t.fake.addThread({ name: 'Bez osoby', owner: ID.app, status: 'Pomysł' });
    t.fake.messages.set(free.id, [t.fake.makeMessage(free.id, free.id, ID.app, 'x')]);
    const noRate = t.fake.addThread({ name: 'Bez stawki', owner: ID.autor, status: 'Opublikowane' });
    assert.match(textOf(await t.rozl(ID.szef, 'premia', [opt('kwota', '10')], free.id)), /nie ma osoby/);
    assert.match(textOf(await t.rozl(ID.szef, 'premia', [opt('kwota', '10')], noRate.id)), /nie ma ustawionej stawki/);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- szkic, zatwierdzenie, wysyłka

test('szkic na początku miesiąca: PDF-y i podsumowanie trafiają do zarządu, osoby nic jeszcze nie dostają', async () => {
  const t = await setup();
  try {
    const { a } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    t.setNow('2026-10-27T10:00:00Z');
    await t.rozl(ID.szef, 'premia', [opt('kwota', '20'), opt('opis', 'post na Facebooku')], a.id);
    await draftForOctober(t);

    const dm = t.dm(ID.szef);
    assert.equal(dm.length, 2, 'podgląd PDF i podsumowanie');
    const files = t.fake.attachmentsOf(dm[0]);
    assert.deepEqual(files.map((f) => f.name), ['protokol-2026-10-oliwia-nowak.pdf']);
    assert.equal(files[0].data.subarray(0, 5).toString(), '%PDF-');
    const text = pdfText(files[0].data);
    if (text !== null) {
      assert.match(text, /październik 2026/);
      assert.match(text, /Oliwia Nowak/);
      assert.match(text, /Recenzja A/);
      assert.match(text, /Poradnik B/);
      assert.match(text, /post na Facebooku/);
      assert.match(text, /Razem do wypłaty\s+320,00\s+zł/);
      assert.match(text, /rozliczenia@gameby\.pl/);
      assert.doesNotMatch(text, /News C/, 'tekst osoby bez stawki nie wchodzi do cudzego protokołu');
    }
    const summary = plain(dm[1].content);
    assert.match(summary, /Rozliczenie za październik 2026: szkic do zatwierdzenia/);
    assert.match(summary, /Oliwia Nowak \(<@\d+>\): 2 teksty, 1 premia, razem 320,00 zł/);
    assert.match(summary, /Razem do wypłaty: 320,00 zł/);
    assert.match(summary, /Bez stawki, więc bez protokołu: <@\d+> \(1 tekst\)/);
    assert.deepEqual(flat(dm[1]).map((c) => c.custom_id), ['kb:fin:send:2026-10', 'kb:fin:refresh:2026-10', 'kb:fin:skip:2026-10']);
    assert.equal(t.dm(ID.oliwia).length, 0, 'osoby dostają protokół dopiero po zatwierdzeniu');
    assert.equal(finOf(t).months['2026-10'].state, 'draft');
    assert.equal(finOf(t).start, '2026-10');
    // szkic nie powstaje drugi raz przy kolejnych odczytach zegara
    await t.bot.financeTick(); await t.bot.financeTick();
    assert.equal(t.dm(ID.szef).length, 2);
    assert.ok(t.logs.log.some((l) => /szkic wysłany do 1 osoby z zarządu/.test(l)));
    assert.doesNotMatch(t.logs.log.join('\n') + t.logs.warn.join('\n') + t.logs.error.join('\n'), /320|150,00|zł/, 'kwoty nie trafiają do logu');
  } finally { await t.close(); }
});

test('zatwierdzenie: potwierdzenie, wysyłka PDF do osób, zamrożenie danych, drugie kliknięcie nic nie robi', async () => {
  const t = await setup();
  try {
    const { a, b, c } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    t.setNow('2026-10-27T10:00:00Z');
    await t.rozl(ID.szef, 'premia', [opt('kwota', '20'), opt('opis', 'post na Facebooku')], a.id);
    await draftForOctober(t);

    const confirm = await t.press('kb:fin:send:2026-10');
    assert.match(plain(editOf(confirm).content), /Wysłać protokoły za październik 2026 do 1 osoby\?\*\* Razem 320,00 zł\./);
    assert.match(plain(editOf(confirm).content), /Tej operacji nie da się cofnąć/);
    assert.match(plain(editOf(confirm).content), /Poza protokołami zostają teksty i premie: bez stawki: 1/);
    assert.equal(t.dm(ID.oliwia).length, 0, 'samo kliknięcie „Wyślij” jeszcze nic nie wysyła');
    const back = await t.press('kb:fin:back:2026-10');
    assert.match(plain(editOf(back).content), /szkic do zatwierdzenia/);

    await t.press('kb:fin:send:2026-10');
    await t.press('kb:fin:yes:2026-10');
    await waitFor(() => finOf(t).months['2026-10'].delivery?.[ID.oliwia]);
    const got = await waitFor(() => t.dm(ID.oliwia)[0]);
    assert.ok(got, 'Oliwia dostała wiadomość prywatną');
    const content = plain(got.content);
    assert.match(content, /protokół rozliczenia za październik 2026 \(GameBy\.pl\)/);
    assert.match(content, /dopisz liczbę przepracowanych godzin, podpisz i odeślij na adres rozliczenia@gameby\.pl/);
    assert.match(content, /Razem do wypłaty: 320,00 zł/);
    assert.match(content, new RegExp(`napisz do <@${ID.szef}>`));
    assert.deepEqual(got.allowed_mentions, { parse: [] }, 'wiadomość nie pinguje');
    const files = t.fake.attachmentsOf(got);
    assert.deepEqual(files.map((f) => f.name), ['protokol-2026-10-oliwia-nowak.pdf']);
    assert.equal(files[0].data.subarray(0, 5).toString(), '%PDF-');
    assert.equal(t.dm(ID.autor).length, 0, 'osoba bez stawki nic nie dostała');

    // zamrożenie: stan i znaczniki rozliczenia
    const fin = finOf(t).months['2026-10'];
    assert.equal(fin.state, 'sent');
    assert.equal(fin.sentBy, ID.szef);
    assert.deepEqual(Object.keys(fin.delivery), [ID.oliwia]);
    assert.equal(metaOf(t, a.id).s, '2026-10');
    assert.equal(metaOf(t, b.id).s, '2026-10');
    assert.equal(metaOf(t, c.id).s, undefined, 'tekst osoby bez stawki zostaje nierozliczony');
    assert.equal(metaOf(t, a.id).b[0].s, '2026-10');
    // podsumowanie u zarządu zostało zamienione na wynik
    const final = plain(t.drafts().length ? t.drafts().at(-1).content : t.dm(ID.szef).at(-1).content);
    assert.match(final, /dostarczono 1 z 1/);
    assert.deepEqual(flat(t.dm(ID.szef).at(-1)), [], 'po wysyłce nie ma już przycisków');

    // drugie zatwierdzenie tego samego szkicu (np. zapomniana wiadomość) nic nie wysyła
    const again = await t.press('kb:fin:yes:2026-10');
    assert.match(plain(again.find((e) => e.kind === 'followup')?.body?.content), /nieaktualny/);
    assert.equal(t.dm(ID.oliwia).length, 1);

    // rozliczony tekst zachowuje datę oddania także wtedy, gdy ktoś cofnie go do pisania i odda ponownie
    t.setNow('2026-11-03T10:00:00Z');
    await t.fake.component(ID.oliwia, a.id, 'kb:go:W pisaniu', { type: 2 });
    assert.equal(metaOf(t, a.id).h, '2026-10-05', 'cofnięcie rozliczonego tekstu nie kasuje daty oddania');
    await t.handIn(a);
    assert.equal(metaOf(t, a.id).h, '2026-10-05', 'ponowne oddanie rozliczonego tekstu nie nadaje nowej daty');
    assert.equal(metaOf(t, a.id).s, '2026-10');
  } finally { await t.close(); }
});

test('zatwierdzenie po zmianie danych: bot nic nie wysyła i pokazuje nowy szkic', async () => {
  const t = await setup();
  try {
    const { a } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await draftForOctober(t);
    const original = t.draftMsg();
    // po szkicu dochodzi premia do tekstu z października (miesiąc jeszcze nie zamknięty)
    await t.rozl(ID.szef, 'premia', [opt('kwota', '30'), opt('opis', 'TikTok')], a.id);
    assert.equal(metaOf(t, a.id).b[0].m, '2026-10');
    await t.press('kb:fin:send:2026-10');
    const ev = await t.press('kb:fin:yes:2026-10');
    assert.match(plain(ev.find((e) => e.kind === 'followup')?.body?.content), /Dane zmieniły się od czasu szkicu/);
    assert.equal(t.dm(ID.oliwia).length, 0, 'nic nie poszło do osób');
    assert.equal(finOf(t).months['2026-10'].state, 'draft');
    assert.equal(metaOf(t, a.id).s, undefined, 'nic nie zostało rozliczone');
    const fresh = await t.newDraftAfter(original);
    assert.ok(fresh, 'przyszedł nowy szkic');
    assert.deepEqual(flat(t.dm(ID.szef).find((m) => m.id === original.id)), [], 'stary szkic nie ma już przycisków');
    assert.match(plain(fresh.content), /Oliwia Nowak \(<@\d+>\): 2 teksty, 1 premia, razem 330,00 zł/);
    // zatwierdzenie nowego szkicu przechodzi
    await t.press('kb:fin:send:2026-10', { messageId: fresh.id });
    await t.press('kb:fin:yes:2026-10', { messageId: fresh.id });
    const got = await waitFor(() => t.dm(ID.oliwia)[0]);
    assert.match(plain(got.content), /Razem do wypłaty: 330,00 zł/);
  } finally { await t.close(); }
});

test('wiadomości prywatne wyłączone u osoby: wysyłka się nie zawiesza, dane są zamrożone, przycisk „Ponów” dosyła protokół', async () => {
  const t = await setup();
  try {
    await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await t.rate(ID.autor, '100', 'Autor Testowy');
    await draftForOctober(t);
    t.fake.blockedDms.add(ID.oliwia);
    await t.press('kb:fin:send:2026-10');
    await t.press('kb:fin:yes:2026-10');
    await waitFor(() => Object.keys(finOf(t).months['2026-10'].delivery || {}).length === 2);
    assert.equal(t.dm(ID.autor).length, 1, 'druga osoba dostała protokół mimo błędu u pierwszej');
    assert.equal(t.dm(ID.oliwia).length, 0);
    const final = await waitFor(() => /dostarczono 1 z 2/.test(plain(t.dm(ID.szef).at(-1).content)) && t.dm(ID.szef).at(-1));
    assert.ok(final, plain(t.dm(ID.szef).at(-1).content));
    assert.match(plain(final.content), /Oliwia Nowak \(<@\d+>\): ma wyłączone wiadomości prywatne od członków serwera/);
    assert.deepEqual(flat(final).map((c) => [c.custom_id, c.label]), [['kb:fin:retry:2026-10', 'Ponów wysyłkę (1)']]);
    assert.equal(finOf(t).months['2026-10'].state, 'sent', 'zatwierdzone dane zostają zamrożone mimo błędu wysyłki');
    assert.equal(metaOf(t, t.fake.threads[0].id).s, '2026-10');

    t.fake.blockedDms.delete(ID.oliwia);
    await t.press('kb:fin:retry:2026-10');
    const retried = await waitFor(() => t.dm(ID.oliwia)[0]);
    assert.ok(retried, 'po ponowieniu protokół dotarł');
    assert.equal(t.dm(ID.autor).length, 1, 'ponowienie nie wysyła drugi raz tym, którzy już dostali');
    await waitFor(() => /dostarczono 2 z 2/.test(plain(t.dm(ID.szef).at(-1).content)));
    assert.match(plain(t.dm(ID.szef).at(-1).content), /dostarczono 2 z 2/);
  } finally { await t.close(); }
});

test('teksty bez daty oddania (sprzed rozliczeń): menu na szkicu przypisuje je do miesiąca i odświeża szkic', async () => {
  let dawno;
  const t = await setup({
    seed: (fake) => {
      fake.addThread({ name: 'Stary tekst 1', owner: ID.oliwia, status: 'Do redakcji', created: '2026-10-03T10:00:00Z' });
      fake.addThread({ name: 'Stary tekst 2', owner: ID.oliwia, status: 'Opublikowane', created: '2026-10-08T10:00:00Z', archived: true });
      dawno = fake.addThread({ name: 'Dawno temu', owner: ID.oliwia, status: 'Opublikowane', created: '2026-06-01T10:00:00Z' });
    },
  });
  try {
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await draftForOctober(t);
    const draft = t.draftMsg();
    assert.match(plain(draft.content), /Bez daty oddania \(tekst z czasów przed rozliczeniami\): 2/);
    assert.match(plain(draft.content), /Nie ma jeszcze nic do rozliczenia z kompletnymi danymi/);
    const menu = flat(draft).find((c) => c.custom_id === 'kb:fin:dated:2026-10');
    assert.deepEqual(menu.options.map((o) => o.label), ['Stary tekst 2', 'Stary tekst 1'], 'najnowsze na górze, post z czerwca się nie pojawia');
    assert.match(menu.options[0].description, /zarchiwizowany/);
    assert.equal(menu.max_values, 2);
    assert.equal(flat(draft).find((c) => c.custom_id === 'kb:fin:send:2026-10').disabled, true, 'bez danych nie ma czego wysyłać');

    // numer spoza listy (podrobiona albo nieaktualna wartość menu) nie nadaje żadnemu postowi daty
    await t.press('kb:fin:dated:2026-10', { type: 3, values: [dawno.id] });
    await t.newDraftAfter(draft);
    assert.equal(metaOf(t, dawno.id)?.h, undefined, 'tekst spoza listy nie dostaje daty oddania');
    const draftAfterForeign = t.draftMsg();

    const first = menu.options.find((o) => o.label === 'Stary tekst 1').value;
    await t.press('kb:fin:dated:2026-10', { type: 3, values: [first] });
    const fresh = await t.newDraftAfter(draftAfterForeign);
    assert.ok(fresh);
    assert.equal(metaOf(t, first).h, '2026-10-31');
    assert.match(plain(fresh.content), /Oliwia Nowak \(<@\d+>\): 1 tekst, razem 150,00 zł/);
    assert.match(plain(fresh.content), /Bez daty oddania \(tekst z czasów przed rozliczeniami\): 1/);
    const old = t.dm(ID.szef).find((m) => m.id === draftAfterForeign.id);
    assert.match(plain(old.content), /Zastąpiony nowszym szkicem/, 'poprzedni szkic traci przyciski');
    assert.deepEqual(flat(old), []);
  } finally { await t.close(); }
});

test('„Pomiń ten miesiąc” zamyka szkic bez rozliczania; /rozliczenia szkic tworzy wtedy nowy protokół', async () => {
  const t = await setup();
  try {
    const { a } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await draftForOctober(t);
    await t.press('kb:fin:skip:2026-10');
    assert.equal(finOf(t).months['2026-10'].state, 'skipped');
    assert.equal(metaOf(t, a.id).s, undefined);
    assert.match(plain(t.dm(ID.szef).at(-1).content), /Pominięto rozliczenie za październik 2026/);
    // kolejny tik nie przygotowuje października od nowa
    t.setNow('2026-11-03T08:30:00Z');
    await t.bot.financeTick();
    assert.equal(Object.keys(finOf(t).months).length, 1);
    // ręcznie: nowy protokół (runda 2), bo poprzedni został pominięty
    const ev = await t.rozl(ID.szef, 'szkic', [opt('miesiac', '2026-10')]);
    assert.match(textOf(ev), /Szkic rozliczenia za październik 2026 wysłałem Ci w wiadomości prywatnej/);
    assert.deepEqual(Object.keys(finOf(t).months).sort(), ['2026-10', '2026-10#2']);
    assert.match(plain(t.draftMsg().content), /październik 2026 \(uzupełnienie 1\): szkic do zatwierdzenia/);
    assert.deepEqual(flat(t.draftMsg()).map((c) => c.custom_id)[0], 'kb:fin:send:2026-10#2');
  } finally { await t.close(); }
});

test('uzupełnienie: po wysłaniu miesiąca osoba, której brakowało stawki, dostaje osobny protokół, reszta nie dostaje drugiego', async () => {
  const t = await setup();
  try {
    await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await draftForOctober(t);
    await t.press('kb:fin:send:2026-10');
    await t.press('kb:fin:yes:2026-10');
    await waitFor(() => finOf(t).months['2026-10'].delivery?.[ID.oliwia]?.ok);
    assert.equal(t.dm(ID.oliwia).length, 1);
    // zarząd ustawia brakującą stawkę i prosi o szkic za październik
    await t.rate(ID.autor, '100', 'Autor Testowy');
    t.setNow('2026-11-04T10:00:00Z');
    const ev = await t.rozl(ID.szef, 'szkic', [opt('miesiac', '10.2026')]);
    assert.match(textOf(ev), /wysłałem Ci w wiadomości prywatnej/);
    const draft = t.draftMsg();
    assert.match(plain(draft.content), /październik 2026 \(uzupełnienie 1\)/);
    assert.match(plain(draft.content), /Autor Testowy \(<@\d+>\): 1 tekst, razem 100,00 zł/);
    assert.doesNotMatch(plain(draft.content), /Oliwia/, 'teksty już rozliczone nie wchodzą drugi raz');
    await t.press('kb:fin:send:2026-10#2', { messageId: draft.id });
    await t.press('kb:fin:yes:2026-10#2', { messageId: draft.id });
    const got = await waitFor(() => t.dm(ID.autor)[0]);
    assert.ok(got);
    assert.deepEqual(t.fake.attachmentsOf(got).map((f) => f.name), ['protokol-2026-10-autor-testowy.pdf']);
    const text = pdfText(t.fake.attachmentsOf(got)[0].data);
    if (text !== null) assert.match(text, /\(uzupełnienie\)/);
    assert.equal(t.dm(ID.oliwia).length, 1, 'Oliwia nie dostała drugiego protokołu');
    assert.equal(finOf(t).months['2026-10'].state, 'sent');
    assert.equal(finOf(t).months['2026-10#2'].state, 'sent');
    // po uzupełnieniu nie ma już czego rozliczać
    const none = await t.rozl(ID.szef, 'szkic', [opt('miesiac', '2026-10')]);
    assert.match(textOf(none), /nie ma nic nowego do rozliczenia/);
  } finally { await t.close(); }
});

test('premia dodana po zamknięciu miesiąca tekstu trafia do bieżącego miesiąca', async () => {
  const t = await setup();
  try {
    const { a } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await draftForOctober(t);
    // szkic za październik już istnieje, ale nie jest zamknięty: premia nadal idzie do października (i wymusi odświeżenie szkicu)
    const early = await t.rozl(ID.szef, 'premia', [opt('kwota', '10')], a.id);
    assert.match(textOf(early), /za październik 2026.*Szkic tego miesiąca już istnieje: odśwież go/);
    const original = t.draftMsg();
    await t.press('kb:fin:send:2026-10');
    await t.press('kb:fin:yes:2026-10'); // zmiana od czasu szkicu: bot odmawia i pokazuje nowy
    const fresh = await t.newDraftAfter(original);
    assert.ok(fresh);
    assert.match(plain(fresh.content), /razem 310,00 zł/);
    await t.press('kb:fin:send:2026-10', { messageId: fresh.id });
    await t.press('kb:fin:yes:2026-10', { messageId: fresh.id });
    await waitFor(() => finOf(t).months['2026-10'].state === 'sent');
    // teraz październik jest zamknięty: kolejna premia za ten sam tekst idzie do listopada
    t.setNow('2026-11-04T10:00:00Z');
    const late = await t.rozl(ID.szef, 'premia', [opt('kwota', '40'), opt('opis', 'YouTube')], a.id);
    assert.match(textOf(late), /Trafi do rozliczenia za listopad 2026\./);
    const bonuses = metaOf(t, a.id).b;
    assert.deepEqual(bonuses.map((b) => [b.a, b.m, b.s]), [[1000, '2026-10', '2026-10'], [4000, '2026-11', undefined]]);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- harmonogram

test('harmonogram: szkic powstaje dopiero od godziny podsumowania pierwszego dnia roboczego, a miesiące sprzed włączenia funkcji są pomijane', async () => {
  const t = await setup();
  try {
    await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await t.bot.financeTick();
    t.setNow('2026-11-01T09:00:00Z'); // niedziela
    await t.bot.financeTick();
    t.setNow('2026-11-02T06:30:00Z'); // poniedziałek 07:30 w Warszawie
    await t.bot.financeTick();
    assert.equal(t.fake.dmChannelOf(ID.szef), null, 'za wcześnie');
    t.setNow('2026-11-02T08:05:00Z'); // 09:05
    await t.bot.financeTick();
    assert.equal(t.drafts().length, 1);
  } finally { await t.close(); }

  // włączenie funkcji w listopadzie: października nikt nie prosił
  const late = await setup({ clock: '2026-11-03T10:00:00Z' });
  try {
    await octoberBoard(late);
    late.setNow('2026-11-03T10:00:00Z');
    await late.bot.financeTick();
    late.setNow('2026-12-01T10:00:00Z');
    await late.bot.financeTick();
    assert.equal(late.fake.dmChannelOf(ID.szef), null, 'bez października, a grudzień jeszcze nie zamknięty');
    assert.equal(finOf(late).start, '2026-11');
  } finally { await late.close(); }
});

test('harmonogram: miesiąc bez niczego do rozliczenia jest pomijany po cichu', async () => {
  const t = await setup();
  try {
    await t.bot.financeTick();
    t.setNow('2026-11-02T08:30:00Z');
    await t.bot.financeTick();
    assert.equal(t.fake.dmChannelOf(ID.szef), null);
    assert.equal(finOf(t).months['2026-10'].state, 'skipped');
    await t.bot.financeTick();
    assert.equal(Object.keys(finOf(t).months).length, 1);
  } finally { await t.close(); }
});

test('harmonogram: gdy zarząd ma wyłączone wiadomości prywatne, bot ponawia co pół godziny; /rozliczenia szkic podpowiada, co zrobić', async () => {
  const t = await setup();
  try {
    await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    t.fake.blockedDms.add(ID.szef);
    await draftForOctober(t);
    assert.equal(finOf(t).months['2026-10'].state, 'draft');
    assert.deepEqual(finOf(t).months['2026-10'].drafts, []);
    assert.ok(t.logs.error.some((l) => /nikt z zarządu nie dostał szkicu/.test(l)));
    // za wcześnie na ponowienie
    t.setNow('2026-11-02T08:50:00Z');
    t.fake.blockedDms.delete(ID.szef);
    await t.bot.financeTick();
    assert.equal(t.drafts().length, 0);
    // po 30 minutach szkic dociera
    t.setNow('2026-11-02T09:10:00Z');
    await t.bot.financeTick();
    assert.equal(t.drafts().length, 1);
    assert.equal(finOf(t).months['2026-10'].drafts.length, 1);
    // komenda przy zablokowanych wiadomościach
    t.fake.blockedDms.add(ID.szef);
    const ev = await t.rozl(ID.szef, 'szkic', [opt('miesiac', '2026-10')]);
    assert.match(textOf(ev), /Nie mogę wysłać Ci wiadomości prywatnej\. Włącz w Discordzie/);
  } finally { await t.close(); }
});

test('/rozliczenia szkic: sprawdza miesiąc, nie przyjmuje bieżącego ani nonsensu', async () => {
  const t = await setup();
  try {
    assert.match(textOf(await t.rozl(ID.szef, 'szkic', [opt('miesiac', 'październik')])), /Nie rozumiem miesiąca/);
    assert.match(textOf(await t.rozl(ID.szef, 'szkic', [opt('miesiac', '2026-10')])), /tylko zakończone miesiące/);
    assert.match(textOf(await t.rozl(ID.szef, 'szkic', [opt('miesiac', '2027-01')])), /tylko zakończone miesiące/);
    assert.match(textOf(await t.rozl(ID.szef, 'szkic')), /nie ma nic nowego do rozliczenia/, 'domyślnie wrzesień: nic nie ma');
  } finally { await t.close(); }
});

test('rozliczenia nie zmieniają zwykłych zadań: karty, tablica i podsumowanie nie zawierają kwot ani stawek', async () => {
  const t = await setup();
  try {
    const { a } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await t.rozl(ID.szef, 'premia', [opt('kwota', '20')], a.id);
    const board = JSON.stringify(((await t.fake.command(ID.autor, 'tablica')).find((e) => e.kind === 'edit') || {}).body);
    const digest = JSON.stringify(((await t.fake.command(ID.autor, 'podsumowanie')).find((e) => e.kind === 'edit') || {}).body);
    for (const text of [board, digest, JSON.stringify(t.fake.messagesOf(a.id))]) assert.doesNotMatch(plain(text), /\d,\d\d|zł|stawk|kwot/i);
    assert.equal(t.fake.dmChannelOf(ID.oliwia), null, 'żadnych wiadomości do osób bez zatwierdzenia');
  } finally { await t.close(); }
});

test('szkic dla wielu osób: PDF-y idą po 10 w wiadomości, a podsumowanie mieści się w limicie i zachowuje ostrzeżenia', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-long-')), 'state.json');
  const owners = Array.from({ length: 30 }, (_, i) => `1000000000000020${String(i).padStart(2, '0')}`);
  const t = await setup({
    clock: '2026-11-03T10:00:00Z',
    env: { STATE_FILE: file },
    seed: (fake) => {
      const tasks = {};
      const rates = {};
      owners.forEach((owner, i) => {
        const th = fake.addThread({ name: `Tekst numer ${i} z dość długim tytułem`, owner, status: 'Opublikowane' });
        tasks[th.id] = { a: owner, h: '2026-10-10' };
        rates[owner] = { name: `Osoba o bardzo długim imieniu i nazwisku numer ${i}`, rate: 10000 + i };
      });
      const orphan = fake.addThread({ name: 'Bez stawki', owner: ID.autor, status: 'Opublikowane' });
      tasks[orphan.id] = { a: ID.autor, h: '2026-10-11' };
      fs.writeFileSync(file, JSON.stringify({ tasks, fin: { start: '2026-10', rates } }));
    },
  });
  try {
    const ev = await t.rozl(ID.szef, 'szkic', [opt('miesiac', '2026-10')]);
    assert.match(textOf(ev), /wysłałem Ci w wiadomości prywatnej/);
    const dm = t.dm(ID.szef);
    assert.equal(dm.length, 4, 'trzy wiadomości z PDF-ami (10 + 10 + 10) i podsumowanie');
    assert.deepEqual(dm.slice(0, 3).map((m) => t.fake.attachmentsOf(m).length), [10, 10, 10]);
    const summary = plain(dm[3].content);
    assert.ok(summary.length <= 2000, `długość ${summary.length}`);
    assert.match(summary, /więcej \(patrz PDF-y wyżej\)/);
    assert.match(summary, /Bez stawki, więc bez protokołu: <@\d+> \(1 tekst\)/, 'ostrzeżenia nie giną przy długiej liście');
    assert.match(summary, /Razem do wypłaty: .* \(30 osób\)/);
    assert.match(summary, /Po zatwierdzeniu bot wyśle każdej osobie/);
    assert.equal(flat(dm[3]).find((c) => c.custom_id === 'kb:fin:send:2026-10').label, 'Wyślij do osób (30)');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- premia za social (tik na karcie)

const cardOf = (t, th) => t.fake.messagesOf(th.id).filter((m) => m.components && m.components.length).at(-1);
const socialIds = (card) => (card.components[3] ? card.components[3].components.map((c) => c.custom_id) : []);
const fieldOf = (card, name) => ((card.embeds[0] || {}).fields || []).find((f) => f.name === name);
const tap = (t, user, th, id) => t.fake.component(user, th.id, id, { type: 2 });
const denied = (events) => plain(events.find((e) => e.kind === 'followup')?.body?.content ?? '');
// Karta w poście powstaje po komendzie /panel użytej w poście.
async function makeCard(t, th) {
  await t.fake.command(ID.oliwia, 'panel', [], th.id);
  return cardOf(t, th);
}

test('premia za social: komenda ustawia stałą kwotę (tylko zarząd), lista stawek ją pokazuje, „brak” ją usuwa', async () => {
  const t = await setup();
  try {
    assert.match(textOf(await t.rozl(ID.szef, 'stawki')), /Premia za social: nie ustawiono/);
    assert.match(textOf(await t.rozl(ID.szef, 'social', [opt('kwota', 'dużo')])), /Nie rozumiem kwoty/);
    assert.match(textOf(await t.rozl(ID.oliwia, 'social', [opt('kwota', '20')])), /tylko dla zarządu/);
    assert.equal(finOf(t), undefined, 'odmowa nic nie zapisuje');
    assert.match(textOf(await t.rozl(ID.szef, 'social', [opt('kwota', '20')])), /Premia za social: 20,00 zł \(jedna stała kwota dla wszystkich\)/);
    assert.equal(finOf(t).social, 2000);
    assert.match(textOf(await t.rozl(ID.szef, 'stawki')), /Premia za social: 20,00 zł \(stała\)/);
    assert.match(textOf(await t.rozl(ID.szef, 'social', [opt('kwota', 'brak')])), /Usunięto kwotę premii za social/);
    assert.equal(finOf(t).social, 0);
    assert.match(textOf(await t.rozl(ID.szef, 'social', [opt('kwota', 'brak')])), /nie ma ustawionej kwoty/);
  } finally { await t.close(); }
});

test('premia za social: bez rozliczeń karta wygląda jak dawniej, a przycisk nic nie robi', async () => {
  const t = await setup({ env: { FINANCE_USER_IDS: '' } });
  try {
    const th = t.fake.addThread({ name: 'Tekst', owner: ID.oliwia, status: 'W pisaniu' });
    const card = await makeCard(t, th);
    assert.equal(card.components.length, 3, 'bez rozliczeń nie ma czwartego rzędu');
    assert.equal(fieldOf(card, 'Premia za social'), undefined);
    assert.match(denied(await tap(t, ID.oliwia, th, 'kb:social:on')), /Rozliczenia są wyłączone/);
    assert.equal(metaOf(t, th.id)?.x, undefined);
    const board = await t.bot.web.board();
    assert.deepEqual(board.tasks.map((x) => x.social), board.tasks.map(() => null), 'strona nie dostaje stanu premii');
  } finally { await t.close(); }
});

test('premia za social: osoba z zadania zgłasza i cofa, obca osoba i zatwierdzanie bez uprawnień są odrzucone, na karcie nie ma kwoty', async () => {
  const t = await setup();
  try {
    await t.rozl(ID.szef, 'social', [opt('kwota', '20')]);
    const th = t.fake.addThread({ name: 'Recenzja social', owner: ID.oliwia, status: 'W pisaniu' });
    let card = await makeCard(t, th);
    assert.deepEqual(socialIds(card), ['kb:social:on']);
    assert.equal(fieldOf(card, 'Premia za social'), undefined, 'bez zgłoszenia nie ma pola');

    assert.match(denied(await tap(t, ID.autor, th, 'kb:social:on')), /zgłasza osoba przypisana do zadania/);
    assert.equal(metaOf(t, th.id)?.x, undefined, 'obca osoba nic nie zmieniła');

    await tap(t, ID.oliwia, th, 'kb:social:on');
    card = cardOf(t, th);
    assert.equal(metaOf(t, th.id).x, true);
    assert.equal(metaOf(t, th.id).b, undefined, 'zgłoszenie nie jest jeszcze premią');
    assert.match(fieldOf(card, 'Premia za social').value, /zgłoszona, czeka na zatwierdzenie/);
    assert.deepEqual(socialIds(card), ['kb:social:off', 'kb:social:ok']);
    await tap(t, ID.oliwia, th, 'kb:social:on'); // podwójne kliknięcie
    assert.equal(metaOf(t, th.id).x, true);

    assert.match(denied(await tap(t, ID.oliwia, th, 'kb:social:ok')), /zatwierdza tylko zarząd/);
    assert.match(denied(await tap(t, ID.autor, th, 'kb:social:off')), /cofa osoba przypisana do zadania albo zarząd/);
    assert.equal(metaOf(t, th.id).x, true);

    await tap(t, ID.oliwia, th, 'kb:social:off');
    card = cardOf(t, th);
    assert.equal(metaOf(t, th.id)?.x, undefined, 'po cofnięciu w stanie nie zostaje ślad');
    assert.equal(fieldOf(card, 'Premia za social'), undefined);
    assert.deepEqual(socialIds(card), ['kb:social:on']);
    assert.doesNotMatch(JSON.stringify(t.fake.messagesOf(th.id)), /zł|\d,\d\d|stawk|kwot/i, 'karta nie zawiera kwot');
  } finally { await t.close(); }
});

test('premia za social: zarząd zatwierdza od razu z karty, kwota zapisuje się w chwili zatwierdzenia, usuwa tylko zarząd', async () => {
  const t = await setup();
  try {
    const th = t.fake.addThread({ name: 'Recenzja social', owner: ID.oliwia, status: 'W pisaniu' });
    await makeCard(t, th);
    assert.match(denied(await tap(t, ID.szef, th, 'kb:social:on')), /Najpierw ustaw kwotę premii za social/);
    assert.equal(metaOf(t, th.id)?.b, undefined);

    await t.rozl(ID.szef, 'social', [opt('kwota', '20')]);
    await tap(t, ID.szef, th, 'kb:social:on');
    let card = cardOf(t, th);
    const b = metaOf(t, th.id).b;
    assert.equal(b.length, 1);
    assert.deepEqual([b[0].a, b[0].n, b[0].m, b[0].k, b[0].s], [2000, 'udostępnienie w social mediach', '2026-10', 'social', undefined]);
    assert.equal(metaOf(t, th.id).x, undefined);
    assert.match(fieldOf(card, 'Premia za social').value, /zatwierdzona/);
    assert.deepEqual(socialIds(card), ['kb:social:off']);
    await tap(t, ID.szef, th, 'kb:social:on'); // drugie kliknięcie nie dubluje premii
    assert.equal(metaOf(t, th.id).b.length, 1);

    // późniejsza zmiana stałej kwoty nie rusza zatwierdzonej premii
    await t.rozl(ID.szef, 'social', [opt('kwota', '30')]);
    assert.equal(metaOf(t, th.id).b[0].a, 2000);

    assert.match(denied(await tap(t, ID.oliwia, th, 'kb:social:off')), /Zatwierdzoną premię za social usuwa tylko zarząd/);
    assert.equal(metaOf(t, th.id).b.length, 1);
    await tap(t, ID.szef, th, 'kb:social:off');
    card = cardOf(t, th);
    assert.equal(metaOf(t, th.id).b, undefined, 'pusta lista premii nie zostaje w stanie');
    assert.deepEqual(socialIds(card), ['kb:social:on']);

    // zadanie bez osoby nie ma komu przyznać premii
    const free = t.fake.addThread({ name: 'Bez osoby', owner: ID.app, status: 'Pomysł' });
    t.fake.messages.set(free.id, [t.fake.makeMessage(free.id, free.id, ID.app, 'x')]);
    await t.fake.component(ID.szef, free.id, 'kb:urgent:on', { type: 2 });
    assert.match(denied(await tap(t, ID.szef, free, 'kb:social:on')), /Najpierw przydziel osobę/);
  } finally { await t.close(); }
});

test('premia za social na szkicu: zgłoszenia czekają w menu, zatwierdzone wchodzą do protokołu, reszta zostaje na następny miesiąc', async () => {
  const t = await setup();
  try {
    const { a, b, c } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await t.rozl(ID.szef, 'social', [opt('kwota', '20')]);
    await tap(t, ID.oliwia, a, 'kb:social:on');
    await tap(t, ID.autor, c, 'kb:social:on'); // osoba bez stawki
    await draftForOctober(t);

    const draft = t.draftMsg();
    assert.match(plain(draft.content), /Oliwia Nowak \(<@\d+>\): 2 teksty, razem 300,00 zł/, 'zgłoszenie jeszcze nie jest w kwocie');
    assert.match(plain(draft.content), /Zgłoszone premie za social do zatwierdzenia: 2\./);
    const menu = flat(draft).find((x) => x.custom_id === 'kb:fin:social:2026-10');
    assert.deepEqual(menu.options.map((o) => o.label), ['News C', 'Recenzja A']);
    assert.deepEqual(menu.options.map((o) => o.description), ['zgłoszenie osoby bez stawki', 'zgłasza: Oliwia Nowak']);

    // numer spoza zgłoszeń (Poradnik B nie ma zgłoszenia) jest ignorowany, zatwierdzenie dotyczy tylko zaznaczonych
    await t.press('kb:fin:social:2026-10', { type: 3, values: [a.id, b.id] });
    const fresh = await t.newDraftAfter(draft);
    assert.ok(fresh);
    assert.match(plain(fresh.content), /Oliwia Nowak \(<@\d+>\): 2 teksty, 1 premia, razem 320,00 zł/);
    assert.match(plain(fresh.content), /Zgłoszone premie za social do zatwierdzenia: 1\./);
    const bonus = metaOf(t, a.id).b[0];
    assert.deepEqual([bonus.a, bonus.m, bonus.k], [2000, '2026-10', 'social']);
    assert.equal(metaOf(t, a.id).x, undefined, 'zgłoszenie zamienione na premię');
    assert.equal(metaOf(t, b.id)?.b, undefined, 'Poradnik B nie dostał premii');
    assert.equal(socialState(t, a), 'ok');

    // przy zatwierdzaniu bot ostrzega, że zgłoszenie osoby bez stawki zostaje
    const confirm = await t.press('kb:fin:send:2026-10', { messageId: fresh.id });
    assert.match(plain(editOf(confirm).content), /Niezatwierdzone zgłoszenia premii za social \(1\) nie wejdą do protokołów; zostają na następny szkic/);
    await t.press('kb:fin:yes:2026-10', { messageId: fresh.id });
    await waitFor(() => finOf(t).months['2026-10'].state === 'sent');
    const pdf = pdfText(t.fake.attachmentsOf(await waitFor(() => t.dm(ID.oliwia)[0]))[0].data);
    if (pdf !== null) {
      assert.match(pdf, /udostępnienie/); // opis zawija się w komórce tabeli, więc sprawdzamy jego początek i koniec osobno
      assert.match(pdf, /mediach/);
      assert.match(pdf, /Razem do wypłaty\s+320,00\s+zł/);
    }

    // rozliczona premia jest zamrożona, niezatwierdzone zgłoszenie czeka dalej
    assert.equal(metaOf(t, a.id).b[0].s, '2026-10');
    assert.equal(socialState(t, a), 'settled');
    assert.match(denied(await tap(t, ID.szef, a, 'kb:social:off')), /już rozliczona w zatwierdzonym protokole/);
    assert.equal(metaOf(t, c.id).x, true, 'zgłoszenie osoby bez stawki zostaje na następny szkic');
    assert.equal(socialState(t, c), 'claimed');
  } finally { await t.close(); }
});

test('premia za social na szkicu: menu pomija zgłoszenia, które zmieniły się po utworzeniu szkicu (cofnięte albo całkiem nowe)', async () => {
  const t = await setup();
  try {
    const { a, c } = await octoberBoard(t);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await t.rozl(ID.szef, 'social', [opt('kwota', '20')]);
    await tap(t, ID.oliwia, a, 'kb:social:on');
    await tap(t, ID.autor, c, 'kb:social:on');
    await draftForOctober(t);
    const draft = t.draftMsg();
    assert.match(plain(draft.content), /Zgłoszone premie za social do zatwierdzenia: 2\./);

    // Autor cofa zgłoszenie już po utworzeniu szkicu, a Oliwia zgłasza drugi tekst, którego szkic jeszcze nie zna.
    await tap(t, ID.autor, c, 'kb:social:off');
    assert.equal(metaOf(t, c.id)?.x, undefined);
    const late = t.fake.addThread({ name: 'Spóźniony social', owner: ID.oliwia, status: 'W pisaniu' });
    await makeCard(t, late);
    await tap(t, ID.oliwia, late, 'kb:social:on');
    assert.equal(metaOf(t, late.id).x, true);

    // Stare menu nadal wysyła numery obu zadań (a nawet cudzy numer): nic z tego nie może stać się premią.
    await t.press('kb:fin:social:2026-10', { type: 3, values: [c.id, late.id, '999999999999999999'] });
    assert.equal(metaOf(t, c.id)?.b, undefined, 'cofnięte zgłoszenie nie staje się premią');
    assert.equal(metaOf(t, late.id).b, undefined, 'zgłoszenie spoza szkicu nie staje się premią');
    assert.equal(metaOf(t, late.id).x, true, 'nowe zgłoszenie czeka na swój szkic');
    assert.equal(socialState(t, a), 'claimed', 'niezaznaczone zgłoszenie też zostaje');
  } finally { await t.close(); }
});

test('premia za social: w szkicu bez kwoty menu nic nie zatwierdza, a samo zgłoszenie wystarcza, żeby miesiąc dostał szkic', async () => {
  const t = await setup();
  try {
    const a = t.fake.addThread({ name: 'Recenzja social', owner: ID.oliwia, status: 'W pisaniu' });
    await makeCard(t, a);
    await t.rate(ID.oliwia, '150', 'Oliwia Nowak');
    await tap(t, ID.oliwia, a, 'kb:social:on');
    await draftForOctober(t); // bez oddanych tekstów, ale ze zgłoszeniem: szkic powstaje
    const draft = t.draftMsg();
    assert.ok(draft, 'zgłoszenie samo wystarcza do szkicu');
    assert.match(plain(draft.content), /Zgłoszone premie za social do zatwierdzenia: 1\./);
    const events = await t.press('kb:fin:social:2026-10', { type: 3, values: [a.id] });
    assert.match(plain(events.find((e) => e.kind === 'followup')?.body?.content ?? ''), /Najpierw ustaw kwotę premii za social/);
    assert.equal(metaOf(t, a.id).x, true, 'bez kwoty nic się nie zmieniło');
  } finally { await t.close(); }
});

// Stan premii wyliczony ze stanu zapisanego na dysku, tak samo jak robi to bot dla karty i strony.
function socialState(t, th) {
  const m = metaOf(t, th.id) || {};
  const list = (m.b || []).filter((x) => x.k === 'social');
  if (list.length) return list.some((x) => x.s) ? 'settled' : 'ok';
  return m.x ? 'claimed' : 'none';
}
