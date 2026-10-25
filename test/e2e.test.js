'use strict';
// Autor: Mateusz Bartoszewicz
// Testy end-to-end: prawdziwy discord.js rozmawia z fałszywym Discordem (bramka + REST).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { boot, opt, EPHEMERAL, ID } = require('./helpers');
const { tagId, TAGS } = require('./fake-discord');

const NOW = new Date('2026-10-24T10:00:00Z'); // sobota
const MONDAY = new Date('2026-10-26T08:05:00Z'); // poniedziałek 09:05 w Warszawie
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); }
  return fn();
}
const url = (id) => `https://discord.com/channels/${ID.guild}/${id}`;

function seedBoard(fake) {
  const a = fake.addThread({ name: 'Recenzja Gry A', owner: ID.autor, status: 'W pisaniu', topics: ['Technologia'], content: `Odpowiedzialny: <@${ID.oliwia}>\nTermin: 2026-10-20` });
  const b = fake.addThread({ name: 'Plansza B', owner: ID.oliwia, status: 'Do redakcji', content: 'Termin: 2026-10-26' });
  const c = fake.addThread({ name: 'Pomysł C', owner: ID.autor, status: 'Pomysł', topics: ['News', 'Evergreen'], content: 'luźny pomysł' });
  const d = fake.addThread({ name: 'Stary D', owner: ID.autor, status: 'Opublikowane', archived: true, content: '' });
  const e = fake.addThread({ name: 'Do pub E', owner: ID.szef, status: 'Do publikacji', content: 'Termin: 2026-10-24' });
  return { a, b, c, d, e };
}
const fieldMap = (embed) => Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
const editOf = (events) => events.find((e) => e.kind === 'edit')?.body;

test('/tablica: kolumny, liczniki, terminy i osoby z pierwszych wiadomości, odpowiedź prywatna', async () => {
  const t = await boot({ now: () => NOW, seed: seedBoard });
  try {
    const ev = await t.fake.command(ID.autor, 'tablica');
    assert.equal(ev[0].kind, 'callback');
    assert.equal(ev[0].type, 5);
    assert.equal(ev[0].data.flags, EPHEMERAL, 'odpowiedź ma być widoczna tylko dla wywołującego');
    const embed = editOf(ev).embeds[0];
    const f = fieldMap(embed);
    assert.deepEqual(Object.keys(f), ['Pomysł (1)', 'Przydzielone (0)', 'W pisaniu (1)', 'Do redakcji (1)', 'Do publikacji (1)', 'Opublikowane (1)']);
    assert.match(f['W pisaniu (1)'], new RegExp(`Recenzja Gry A\\]\\(${url(t.fake.threads[0].id)}\\) <@${ID.oliwia}> · 20\\.10, po terminie o 4 dni`));
    assert.match(f['Do redakcji (1)'], new RegExp(`📝 \\[Plansza B.*<@${ID.oliwia}> · tekst oddany`), 'oddany tekst nie ma już odliczania terminu');
    assert.match(f['Do publikacji (1)'], /📝 .*tekst oddany/);
    assert.doesNotMatch(f['Do publikacji (1)'], /dziś|po terminie/);
    assert.match(f['Opublikowane (1)'], /Stary D/, 'zarchiwizowane posty też są na tablicy');
    assert.match(f['Pomysł (1)'], /Pomysł C/);
    assert.equal(editOf(ev).allowedMentions?.parse?.length ?? editOf(ev).allowed_mentions?.parse?.length, 0, 'bez pingów');
  } finally { await t.close(); }
});

test('/tablica moje:true pokazuje tylko zadania przypisane do wywołującego', async () => {
  const t = await boot({ now: () => NOW, seed: seedBoard });
  try {
    const ev = await t.fake.command(ID.oliwia, 'tablica', [opt('moje', true, 5)]);
    const embed = editOf(ev).embeds[0];
    assert.equal(embed.title, 'Tablica: moje zadania');
    const text = JSON.stringify(embed);
    assert.match(text, /Recenzja Gry A/);
    assert.match(text, /Plansza B/);
    assert.doesNotMatch(text, /Pomysł C|Stary D|Do pub E/);
  } finally { await t.close(); }
});

test('/tablica publicznie:true: odpowiedź zostaje prywatna, tablica trafia zwykłą wiadomością na kanał redakcji', async () => {
  const t = await boot({ now: () => NOW, seed: seedBoard });
  try {
    const ev = await t.fake.command(ID.autor, 'tablica', [opt('publicznie', true, 5)], ID.ogolne);
    assert.equal(ev[0].data.flags, EPHEMERAL);
    assert.equal(ev.filter((e) => e.kind === 'followup' || e.kind === 'delete').length, 0, 'bez follow-upów i usuwania odpowiedzi');
    assert.match(editOf(ev).content, /Wysłano tablicę na ten kanał/);
    const posted = t.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length);
    assert.equal(posted.length, 1, 'tablica ma być zwykłą wiadomością na kanale');
    assert.equal(posted[0].embeds[0].fields.length, 6);
    assert.deepEqual(posted[0].allowed_mentions, { parse: [] });
  } finally { await t.close(); }
});

test('/tablica publicznie:true na kanale widocznym dla wszystkich jest odrzucone i nic nie wycieka', async () => {
  const t = await boot({ now: () => NOW, seed: seedBoard });
  try {
    const ev = await t.fake.command(ID.autor, 'tablica', [opt('publicznie', true, 5)], ID.pogaduszki);
    assert.match(editOf(ev).content, /nie widzą osoby spoza redakcji/);
    assert.equal(t.fake.messagesOf(ID.pogaduszki).length, 0);
    assert.equal(editOf(ev).embeds, undefined);
  } finally { await t.close(); }
});

test('bez Message Content Intent terminy z cudzych postów nie są odczytywane, ale tablica działa', async () => {
  const t = await boot({ env: { MESSAGE_CONTENT: '0' }, now: () => NOW, seed: seedBoard });
  try {
    assert.equal(t.fake.intents & (1 << 15), 0, 'bot nie powinien żądać uprzywilejowanego intentu');
    assert.ok(t.logs.log.some((l) => /Message Content wyłączone/.test(l)));
    const ev = await t.fake.command(ID.autor, 'tablica');
    const f = fieldMap(editOf(ev).embeds[0]);
    assert.doesNotMatch(f['W pisaniu (1)'], /po terminie/);
    assert.match(f['W pisaniu (1)'], new RegExp(`<@${ID.autor}>`), 'bez treści osobą jest autor posta');
    assert.doesNotMatch(f['Do redakcji (1)'], /26\.10/);
  } finally { await t.close(); }
});

test('osoba spoza redakcji nie widzi niczego i nic nie utworzy', async () => {
  const t = await boot({ now: () => NOW, seed: seedBoard });
  try {
    for (const [cmd, opts] of [['tablica', []], ['podsumowanie', []], ['zadanie', [opt('tytul', 'Włamanie')]], ['panel', []]]) {
      const ev = await t.fake.command(ID.obcy, cmd, opts, ID.pogaduszki);
      const body = editOf(ev);
      assert.equal(body.content, 'Ta funkcja jest tylko dla redakcji.', cmd);
      assert.equal(body.embeds, undefined, cmd);
    }
    assert.equal(t.fake.created, undefined, 'powstał post mimo braku dostępu');
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\//).length, 0);
  } finally { await t.close(); }
});

const flat = (msg) => msg.components.flatMap((row) => row.components);
const cardsIn = (fake, id) => fake.messagesOf(id).filter((m) => m.components.length);

test('/zadanie: post z tagiem i opisem, karta z przyciskami, ping tylko dla przydzielonej osoby, jedna karta mimo THREAD_CREATE', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const ev = await t.fake.command(ID.autor, 'zadanie', [
      opt('tytul', 'Nowy tekst o konsolach'), opt('osoba', ID.oliwia, 6), opt('termin', '05.11'), opt('opis', 'Źródła w wątku'),
    ]);
    assert.equal(ev[0].data.flags, EPHEMERAL);
    assert.equal(t.fake.created.length, 1);
    const { thread, body } = t.fake.created[0];
    assert.equal(body.name, 'Nowy tekst o konsolach');
    assert.deepEqual(body.applied_tags, [tagId('Przydzielone')]);
    assert.equal(body.message.content, 'Źródła w wątku', 'osoba i termin są na karcie, nie w treści');
    assert.deepEqual(body.message.allowed_mentions, { parse: [] });
    assert.match(editOf(ev).content, new RegExp(`Dodano zadanie \\(Przydzielone, termin 05\\.11\\.2026\\): ${url(thread.id)}`));

    await waitFor(() => t.fake.messagesOf(thread.id).length >= 3);
    await sleep(200); // THREAD_CREATE od Discorda nie może dodać drugiej karty
    const cards = cardsIn(t.fake, thread.id);
    assert.equal(cards.length, 1);
    const card = cards[0];
    assert.equal(card.content, 'Status: **Przydzielone**');
    assert.deepEqual(card.embeds[0].fields.map((f) => [f.name, f.value]), [['Osoba', `<@${ID.oliwia}>`], ['Termin', '05.11.2026'], ['Priorytet', 'zwykły']]);
    const [row1, row2, row3] = card.components;
    const select = row1.components[0];
    assert.equal(select.custom_id, 'kb:status');
    assert.deepEqual(select.options.map((o) => o.value), ['Pomysł', 'Przydzielone', 'W pisaniu', 'Do redakcji', 'Do publikacji', 'Opublikowane']);
    assert.deepEqual(select.options.filter((o) => o.default).map((o) => o.value), ['Przydzielone']);
    assert.deepEqual(row2.components.map((b) => [b.custom_id, !!b.disabled]), [['kb:go:Pomysł', false], ['kb:go:W pisaniu', false], ['kb:release', false], ['kb:due', false], ['kb:urgent:on', false]]);
    assert.deepEqual([row3.components[0].type, row3.components[0].custom_id], [5, 'kb:assign'], 'menu wyboru osoby');

    const ping = t.fake.messagesOf(thread.id).find((m) => /to zadanie jest teraz Twoje/.test(m.content));
    assert.ok(ping, 'przydzielona osoba dostaje wiadomość w poście');
    assert.match(ping.content, new RegExp(`^<@${ID.oliwia}> .*<@${ID.autor}>`));
    assert.deepEqual(ping.allowed_mentions, { users: [ID.oliwia] }, 'ping tylko do przydzielonej osoby');

    const board = await t.fake.command(ID.autor, 'tablica');
    const f = fieldMap(editOf(board).embeds[0]);
    assert.match(f['Przydzielone (1)'], new RegExp(`Nowy tekst o konsolach.*<@${ID.oliwia}> · 05\\.11, za 12 dni`));
    assert.deepEqual(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[thread.id], { a: ID.oliwia, d: '2026-11-05', u: false, c: card.id });
  } finally { await t.close(); }
});

test('/zadanie bez osoby trafia do kolumny Pomysł bez pinga; zły termin jest odrzucony i nic nie powstaje; przydział sobie nie pinguje', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const bad = await t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'X'), opt('termin', 'jutro')]);
    assert.match(editOf(bad).content, /Nie rozumiem terminu/);
    assert.equal(t.fake.created, undefined);
    const ok = await t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'Luźny pomysł')]);
    assert.match(editOf(ok).content, /\(Pomysł\)/);
    const { thread, body } = t.fake.created[0];
    assert.deepEqual(body.applied_tags, [tagId('Pomysł')]);
    assert.equal(body.message.content, `Zadanie dodane przez <@${ID.autor}>.`);
    await waitFor(() => cardsIn(t.fake, thread.id).length === 1);
    assert.equal(cardsIn(t.fake, thread.id)[0].embeds[0].fields[0].value, 'brak, kliknij „Biorę to”');
    assert.equal(t.fake.messagesOf(thread.id).length, 2, 'treść i karta, bez wiadomości z pingiem');

    const self = await t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'Dla siebie'), opt('osoba', ID.autor, 6)]);
    assert.match(editOf(self).content, /\(Przydzielone\)/);
    const mine = t.fake.created[1].thread;
    await waitFor(() => cardsIn(t.fake, mine.id).length === 1);
    assert.equal(t.fake.messagesOf(mine.id).length, 2, 'przydział sobie nie wysyła pinga');
  } finally { await t.close(); }
});

test('menu statusu: zmienia tag, zachowuje tagi tematów, odświeża panel', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    const ev = await t.fake.component(ID.autor, ids.c.id, 'kb:status', { values: ['W pisaniu'] });
    assert.equal(ev[0].type, 6, 'odpowiedź typu DEFERRED_UPDATE_MESSAGE');
    const patch = t.fake.requestsTo('PATCH', new RegExp(`^/channels/${ids.c.id}$`));
    assert.equal(patch.length, 1);
    assert.deepEqual(patch[0].body.applied_tags.sort(), [tagId('News'), tagId('Evergreen'), tagId('W pisaniu')].sort());
    const panel = editOf(ev);
    assert.equal(panel.content, 'Status: **W pisaniu**');
    assert.deepEqual(panel.components[0].components[0].options.filter((o) => o.default).map((o) => o.value), ['W pisaniu']);
    assert.equal(t.fake.thread(ids.c.id).applied_tags.includes(tagId('Pomysł')), false);
  } finally { await t.close(); }
});

test('przyciski Dalej i Wstecz przesuwają o jeden status; na końcach nie ma ruchu', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    const next = await t.fake.component(ID.autor, ids.a.id, 'kb:next', { type: 2 }); // W pisaniu -> Do redakcji
    assert.equal(editOf(next).content, 'Status: **Do redakcji**');
    const prev = await t.fake.component(ID.autor, ids.a.id, 'kb:prev', { type: 2 }); // -> W pisaniu
    assert.equal(editOf(prev).content, 'Status: **W pisaniu**');
    const first = await t.fake.component(ID.autor, ids.c.id, 'kb:prev', { type: 2 }); // Pomysł nie ma poprzedniego
    const msg = first.find((e) => e.kind === 'followup').body;
    assert.match(msg.content, /Nie ma takiego statusu/);
    assert.equal(msg.flags, EPHEMERAL);
  } finally { await t.close(); }
});

test('statusy Do publikacji i Opublikowane ustawia tylko osoba z uprawnieniem Zarządzanie wątkami', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    const denied = await t.fake.component(ID.autor, ids.b.id, 'kb:next', { type: 2 }); // Do redakcji -> Do publikacji
    const msg = denied.find((e) => e.kind === 'followup').body;
    assert.match(msg.content, /kierownictwo lub moderacja/);
    assert.equal(msg.flags, EPHEMERAL);
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\//).length, 0, 'tag nie może się zmienić');
    assert.ok(t.fake.thread(ids.b.id).applied_tags.includes(tagId('Do redakcji')));

    const deniedSelect = await t.fake.component(ID.autor, ids.c.id, 'kb:status', { values: ['Opublikowane'] });
    assert.match(deniedSelect.find((e) => e.kind === 'followup').body.content, /kierownictwo lub moderacja/);

    const ok = await t.fake.component(ID.szef, ids.b.id, 'kb:next', { type: 2 });
    assert.equal(editOf(ok).content, 'Status: **Do publikacji**');
    assert.ok(t.fake.thread(ids.b.id).applied_tags.includes(tagId('Do publikacji')));

    const back = await t.fake.component(ID.autor, ids.e.id, 'kb:prev', { type: 2 }); // cofnięcie z Do publikacji też zablokowane
    assert.match(back.find((e) => e.kind === 'followup').body.content, /kierownictwo lub moderacja/);
  } finally { await t.close(); }
});

test('zmiana statusu w zarchiwizowanym poście najpierw go odarchiwizowuje', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    const ev = await t.fake.component(ID.szef, ids.d.id, 'kb:prev', { type: 2 }); // Opublikowane -> Do publikacji
    assert.equal(editOf(ev).content, 'Status: **Do publikacji**');
    const patches = t.fake.requestsTo('PATCH', new RegExp(`^/channels/${ids.d.id}$`));
    assert.ok(patches.some((p) => p.body.archived === false), 'brak odarchiwizowania');
    assert.ok(patches.some((p) => p.body.applied_tags), 'brak zmiany tagów');
    assert.equal(t.fake.thread(ids.d.id).thread_metadata.archived, false);
  } finally { await t.close(); }
});

test('panel w cudzym kanale lub poście spoza forum jest odrzucony', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const other = t.fake.addThread({ name: 'Wątek w ogólnym', parent: ID.ogolne, status: null });
    const ev = await t.fake.component(ID.autor, other.id, 'kb:next', { type: 2 });
    assert.match(ev.find((e) => e.kind === 'followup').body.content, /tylko w postach na forum/);
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\//).length, 0);
    const cmd = await t.fake.command(ID.autor, 'panel', [], ID.ogolne);
    assert.match(editOf(cmd).content, /tylko w postach na forum/);
  } finally { await t.close(); }
});

test('nowy post założony ręcznie: bot dodaje status Pomysł (zachowując tematy) i panel', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = t.fake.addThread({ name: 'Ręczny post', owner: ID.autor, status: null, topics: ['Planszówki'], content: 'treść' });
    t.fake.dispatch('THREAD_CREATE', { ...th, newly_created: true });
    await waitFor(() => t.fake.messagesOf(th.id).some((m) => m.components.length));
    const patch = t.fake.requestsTo('PATCH', new RegExp(`^/channels/${th.id}$`));
    assert.equal(patch.length, 1);
    assert.deepEqual(patch[0].body.applied_tags.sort(), [tagId('Planszówki'), tagId('Pomysł')].sort());
    assert.equal(t.fake.messagesOf(th.id).find((m) => m.components.length).content, 'Status: **Pomysł**');
  } finally { await t.close(); }
});

test('nowy post z istniejącym statusem: tylko panel; post spoza forum i stare zdarzenia są ignorowane', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const withStatus = t.fake.addThread({ name: 'Ma status', owner: ID.autor, status: 'W pisaniu' });
    t.fake.dispatch('THREAD_CREATE', { ...withStatus, newly_created: true });
    await waitFor(() => t.fake.messagesOf(withStatus.id).some((m) => m.components.length));
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${withStatus.id}$`)).length, 0);
    assert.equal(t.fake.messagesOf(withStatus.id).find((m) => m.components.length).content, 'Status: **W pisaniu**');

    const elsewhere = t.fake.addThread({ name: 'Gdzie indziej', parent: ID.ogolne, status: null });
    t.fake.dispatch('THREAD_CREATE', { ...elsewhere, newly_created: true });
    const old = t.fake.addThread({ name: 'Stary', owner: ID.autor, status: null });
    t.fake.dispatch('THREAD_CREATE', { ...old, newly_created: false });
    await sleep(300);
    assert.equal(t.fake.messagesOf(elsewhere.id).filter((m) => m.components.length).length, 0);
    assert.equal(t.fake.messagesOf(old.id).filter((m) => m.components.length).length, 0);
  } finally { await t.close(); }
});

test('/panel w poście dodaje kartę z aktualnym statusem i zastępuje poprzednią zamiast mnożyć karty', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    const ev = await t.fake.command(ID.autor, 'panel', [], ids.a.id);
    assert.match(editOf(ev).content, /Dodano kartę zadania/);
    const first = cardsIn(t.fake, ids.a.id);
    assert.equal(first.length, 1);
    assert.equal(first[0].content, 'Status: **W pisaniu**');
    assert.deepEqual(first[0].embeds[0].fields.map((f) => f.value), [`<@${ID.oliwia}>`, '20.10.2026', 'zwykły'], 'osoba i termin z treści ręcznego posta');
    await t.fake.command(ID.autor, 'panel', [], ids.a.id);
    const second = cardsIn(t.fake, ids.a.id);
    assert.equal(second.length, 1, 'stara karta jest usuwana');
    assert.notEqual(second[0].id, first[0].id);
  } finally { await t.close(); }
});

test('podsumowanie dnia: wysyłane raz, w oknie czasowym, tylko w dni robocze, stan zapisany na dysku', async () => {
  let clock = MONDAY;
  const t = await boot({ now: () => clock, seed: seedBoard });
  try {
    await t.app.bot.digestTick();
    const msgs = t.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length);
    assert.equal(msgs.length, 1);
    const f = fieldMap(msgs[0].embeds[0]);
    assert.deepEqual(Object.keys(f), ['Po terminie (1)', 'Czeka na redakcję (1)', 'Gotowe do publikacji (1)'], 'oddane teksty nie są „po terminie” ani „w ciągu 3 dni”');
    assert.match(f['Po terminie (1)'], /Recenzja Gry A.*po terminie o 6 dni/s);
    assert.match(f['Czeka na redakcję (1)'], /Plansza B.*tekst oddany/s);
    assert.match(f['Gotowe do publikacji (1)'], /Do pub E.*tekst oddany/s);
    assert.equal(msgs[0].content, '', 'bez pingów domyślnie');
    assert.deepEqual(msgs[0].allowed_mentions, { parse: [] });
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).lastDigest, '2026-10-26');

    await t.app.bot.digestTick();
    assert.equal(t.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length).length, 1, 'drugi raz tego samego dnia nie wysyła');

    clock = new Date('2026-10-27T15:30:00Z'); // wtorek 16:30: po oknie
    await t.app.bot.digestTick();
    assert.equal(t.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length).length, 1);
    clock = new Date('2026-10-31T08:05:00Z'); // sobota
    await t.app.bot.digestTick();
    assert.equal(t.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length).length, 1);
    clock = new Date('2026-10-28T08:05:00Z'); // środa rano
    await t.app.bot.digestTick();
    assert.equal(t.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length).length, 2);
  } finally { await t.close(); }
});

test('podsumowanie z DIGEST_PING=1 oznacza tylko osoby z zadaniami po terminie lub z bliskim terminem (nie tych, którzy już oddali tekst)', async () => {
  const t = await boot({ env: { DIGEST_PING: '1' }, now: () => MONDAY, seed: seedBoard });
  try {
    await t.app.bot.digestTick();
    const m = t.fake.messagesOf(ID.ogolne).find((x) => x.embeds.length);
    assert.equal(m.content, `<@${ID.oliwia}>`, 'Oliwia: tekst w pisaniu po terminie; szef i jej druga plansza są oddane, więc bez pinga');
    assert.deepEqual(m.allowed_mentions, { users: [ID.oliwia] });
  } finally { await t.close(); }
});

test('podsumowanie: brak zadań do pokazania nie wysyła wiadomości, ale zalicza dzień; wyłączone przez DIGEST_ENABLED=0', async () => {
  const empty = await boot({ now: () => MONDAY });
  try {
    await empty.app.bot.digestTick();
    assert.equal(empty.fake.messagesOf(ID.ogolne).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(empty.stateFile, 'utf8')).lastDigest, '2026-10-26');
  } finally { await empty.close(); }
  const off = await boot({ env: { DIGEST_ENABLED: '0' }, now: () => MONDAY, seed: seedBoard });
  try {
    await off.app.bot.digestTick();
    assert.equal(off.fake.messagesOf(ID.ogolne).length, 0);
  } finally { await off.close(); }
});

test('podsumowanie: brak kanału docelowego to błąd konfiguracji logowany raz, bez pętli co minutę', async () => {
  const t = await boot({ env: { DIGEST_CHANNEL_NAME: 'nie-ma-takiego' }, now: () => MONDAY, seed: seedBoard });
  try {
    await t.app.bot.digestTick();
    await t.app.bot.digestTick();
    assert.equal(t.logs.error.filter((l) => /Nie widzę kanału podsumowania/.test(l)).length, 1);
  } finally { await t.close(); }
});

test('/podsumowanie: podgląd prywatny albo informacja, że nic nie czeka', async () => {
  const t = await boot({ now: () => MONDAY, seed: seedBoard });
  try {
    const ev = await t.fake.command(ID.autor, 'podsumowanie');
    assert.equal(ev[0].data.flags, EPHEMERAL);
    assert.equal(editOf(ev).embeds[0].title, 'Podsumowanie dnia');
  } finally { await t.close(); }
  const none = await boot({ now: () => MONDAY });
  try {
    const ev = await none.fake.command(ID.autor, 'podsumowanie');
    assert.match(editOf(ev).content, /Nic nie czeka/);
  } finally { await none.close(); }
});

test('brakujące tagi statusu: ostrzeżenie przy starcie i czytelny komunikat zamiast awarii', async () => {
  const tags = TAGS.filter((x) => x.name !== 'W pisaniu' && x.name !== 'Do redakcji');
  const t = await boot({ fakeOpts: { tags }, now: () => NOW });
  try {
    assert.ok(t.logs.warn.some((w) => /brakuje tagów statusu: W pisaniu, Do redakcji/.test(w)), t.logs.warn.join('|'));
    const ev = await t.fake.command(ID.autor, 'tablica');
    assert.match(editOf(ev).content, /brakuje tagów statusu: W pisaniu, Do redakcji/);
    const z = await t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'X')]);
    assert.match(editOf(z).content, /brakuje tagów statusu/);
    assert.equal(t.fake.created, undefined);
  } finally { await t.close(); }
});

test('interakcje z innego serwera są ignorowane', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const ev = await t.fake.command(ID.autor, 'tablica', [], ID.ogolne, '999999999999999999', { timeout: 600 });
    assert.deepEqual(ev, []);
  } finally { await t.close(); }
});

test('błąd Discorda przy pobieraniu wątków: użytkownik dostaje komunikat, bot działa dalej', async () => {
  const t = await boot({ now: () => NOW, seed: seedBoard });
  try {
    t.fake.failures.push({ re: /^GET \/guilds\/\d+\/threads\/active/, status: 403 });
    const ev = await t.fake.command(ID.autor, 'tablica');
    assert.match(editOf(ev).content, /Coś poszło nie tak/);
    assert.ok(t.logs.error.length >= 1);
    const again = await t.fake.command(ID.autor, 'tablica');
    assert.equal(editOf(again).embeds[0].fields.length, 6);
  } finally { await t.close(); }
});

test('wiele zadań: tablica mieści się w limitach embeda (6000 znaków, pola do 1024)', async () => {
  const t = await boot({ now: () => NOW, seed: (f) => {
    for (let i = 0; i < 60; i += 1) f.addThread({ name: `Zadanie numer ${i} z bardzo długim tytułem, który zajmuje miejsce w kolumnie`, owner: ID.autor, status: ['Pomysł', 'W pisaniu', 'Do redakcji'][i % 3], content: `Termin: 2026-11-${String(1 + (i % 28)).padStart(2, '0')}` });
  } });
  try {
    const ev = await t.fake.command(ID.autor, 'tablica');
    const embed = editOf(ev).embeds[0];
    const total = embed.title.length + embed.footer.text.length + embed.fields.reduce((s, x) => s + x.name.length + x.value.length, 0);
    assert.ok(total <= 6000, `embed ma ${total} znaków`);
    assert.ok(embed.fields.every((x) => x.value.length <= 1024));
    assert.match(JSON.stringify(embed), /… i \d+ więcej/);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- poprawki po niezależnym przeglądzie
const { P } = require('./fake-discord');
const getArchivedPages = (fake) => fake.requestsTo('GET', /threads\/archived\/public$/);

test('archiwum: bot pobiera kolejne strony, więc stare zarchiwizowane zadanie po terminie nie ginie z tablicy i podsumowania', async () => {
  const t = await boot({ now: () => MONDAY, seed: (f) => {
    f.addThread({ name: 'Zapomniane zadanie', owner: ID.autor, status: 'W pisaniu', archived: true, archivedAt: '2026-01-05T10:00:00Z', content: `Odpowiedzialny: <@${ID.oliwia}>\nTermin: 2026-10-01` });
    for (let i = 0; i < 230; i += 1) f.addThread({ name: `Opublikowany ${i}`, status: 'Opublikowane', archived: true, archivedAt: Date.UTC(2026, 5, 1) + i * 60000, content: '' });
  } });
  try {
    const board = await t.fake.command(ID.autor, 'tablica');
    const f = fieldMap(editOf(board).embeds[0]);
    assert.match(f['W pisaniu (1)'], /Zapomniane zadanie/);
    assert.ok(f['Opublikowane (230)'], Object.keys(f).join('|'));
    const pages = getArchivedPages(t.fake);
    assert.equal(pages.length, 3, '231 postów = strony po 100, 100 i 31');
    assert.equal(pages[0].query.before, undefined);
    assert.ok(pages[1].query.before && pages[2].query.before, 'kolejne strony idą przez znacznik czasu before');
    assert.equal(pages[0].query.limit, '100');
    assert.doesNotMatch(editOf(board).embeds[0].footer.text, /starszych nie widać/);

    await t.app.bot.digestTick();
    const m = t.fake.messagesOf(ID.ogolne).find((x) => x.embeds.length);
    assert.match(fieldMap(m.embeds[0])['Po terminie (1)'], /Zapomniane zadanie/);
  } finally { await t.close(); }
});

test('archiwum: limit 5 stron, a obcięcie jest widoczne w stopce tablicy i podsumowania', async () => {
  const t = await boot({ now: () => MONDAY, seed: (f) => {
    f.addThread({ name: 'Zaległe', owner: ID.autor, status: 'W pisaniu', content: 'Termin: 2026-10-01' });
    for (let i = 0; i < 650; i += 1) f.addThread({ name: `Opublikowany ${i}`, status: 'Opublikowane', archived: true, archivedAt: Date.UTC(2026, 5, 1) + i * 60000, content: '' });
  } });
  try {
    const board = await t.fake.command(ID.autor, 'tablica');
    assert.equal(getArchivedPages(t.fake).length, 5);
    assert.match(editOf(board).embeds[0].footer.text, /500 najnowszych zarchiwizowanych postów, starszych nie widać/);
    await t.app.bot.digestTick();
    const m = t.fake.messagesOf(ID.ogolne).find((x) => x.embeds.length);
    assert.match(m.embeds[0].footer.text, /starszych nie widać/);
  } finally { await t.close(); }
});

test('selfCheck: ostrzega, gdy tagi statusów końcowych nie są moderowane (autor ustawiłby je ręcznie)', async () => {
  const tags = TAGS.map((x) => ({ ...x, moderated: false }));
  const t = await boot({ fakeOpts: { tags }, now: () => NOW });
  try {
    assert.ok(t.logs.warn.some((w) => /"Do publikacji" nie jest moderowany/.test(w)), t.logs.warn.join('|'));
    assert.ok(t.logs.warn.some((w) => /"Opublikowane" nie jest moderowany/.test(w)));
  } finally { await t.close(); }
});

test('selfCheck: bez wymaganych uprawnień bot wypisuje czego brakuje; bez dostępu do forum mówi to wprost', async () => {
  const limited = await boot({ now: () => NOW, seed: (f) => {
    f.roles[0].permissions = String(P.VIEW);
    f.roles.find((r) => r.id === ID.rBot).permissions = String(P.VIEW);
    f.botRoles = [ID.rBot, ID.rRedakcja];
  } });
  try {
    const w = limited.logs.warn.join('|');
    assert.match(w, /bot nie ma na forum uprawnień:.*Wysyłanie wiadomości.*Zarządzanie wątkami/);
    assert.match(w, /bot nie ma na kanale podsumowania uprawnień:.*Wysyłanie wiadomości/);
  } finally { await limited.close(); }

  const blind = await boot({ now: () => NOW, seed: (f) => { f.roles.find((r) => r.id === ID.rBot).permissions = '0'; } });
  try {
    assert.ok(blind.logs.warn.some((x) => /Nie widzę forum "artykuly"/.test(x)), blind.logs.warn.join('|'));
    const ev = await blind.fake.command(ID.autor, 'tablica');
    assert.match(editOf(ev).content, /Bot nie widzi forum zadań/);
    assert.doesNotMatch(editOf(ev).content, /artykuly/, 'komunikat dla użytkownika nie ujawnia konfiguracji');
  } finally { await blind.close(); }
});

test('podsumowanie: kanał widoczny dla wszystkich jest odrzucony, a z dwóch kanałów o tej samej nazwie wybierany jest prywatny', async () => {
  const pub = await boot({ env: { DIGEST_CHANNEL_NAME: 'pogaduszki' }, now: () => MONDAY, seed: seedBoard });
  try {
    assert.ok(pub.logs.warn.some((w) => /podsumowanie dnia nie zadziała: .*widoczny dla wszystkich/.test(w)), pub.logs.warn.join('|'));
    await pub.app.bot.digestTick();
    await pub.app.bot.digestTick();
    assert.equal(pub.fake.messagesOf(ID.pogaduszki).length, 0, 'tytuły z prywatnego forum nie mogą trafić na publiczny kanał');
    assert.equal(pub.logs.error.filter((l) => /widoczny dla wszystkich/.test(l)).length, 1);
  } finally { await pub.close(); }

  let publicDuplicate;
  const dup = await boot({ now: () => MONDAY, seed: (f) => { seedBoard(f); publicDuplicate = f.addTextChannel('ogolne', { first: true }); } });
  try {
    await dup.app.bot.digestTick();
    assert.equal(dup.fake.messagesOf(publicDuplicate.id).length, 0);
    assert.equal(dup.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length).length, 1);
  } finally { await dup.close(); }
});

test('podsumowanie: brak uprawnień do wysyłki (403) to błąd trwały: jeden wpis w logu, bez ponawiania co minutę', async () => {
  const t = await boot({ now: () => MONDAY, seed: seedBoard });
  try {
    t.fake.failures.push({ re: /^POST \/channels\/\d+\/messages$/, status: 403 });
    await t.app.bot.digestTick();
    await t.app.bot.digestTick();
    assert.equal(t.logs.error.filter((l) => /Podsumowanie dnia pominięte/.test(l)).length, 1, t.logs.error.join('|'));
    assert.equal(t.fake.requestsTo('POST', /^\/channels\/\d+\/messages$/).length, 1, 'tylko jedna próba wysyłki');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).lastDigest, '2026-10-26');
  } finally { await t.close(); }
});

test('podsumowanie: chwilowy błąd Discorda jest ponawiany po 10 minutach, nie co minutę', async () => {
  let clock = MONDAY;
  const t = await boot({ now: () => clock, seed: seedBoard });
  try {
    t.fake.failures.push({ re: /^GET \/guilds\/\d+\/threads\/active/, status: 400 });
    await t.app.bot.digestTick();
    assert.ok(t.logs.error.some((l) => /próba 1, następna za 10 minut/.test(l)), t.logs.error.join('|'));
    clock = new Date(MONDAY.getTime() + 60 * 1000);
    await t.app.bot.digestTick();
    assert.equal(t.fake.requestsTo('GET', /threads\/active$/).length, 1, 'po minucie bot jeszcze nie próbuje');
    clock = new Date(MONDAY.getTime() + 11 * 60 * 1000);
    await t.app.bot.digestTick();
    assert.equal(t.fake.messagesOf(ID.ogolne).filter((m) => m.embeds.length).length, 1);
  } finally { await t.close(); }
});

test('podsumowanie: nieudane pobranie terminów nie jest zapisywane jako "brak terminu", tylko ponawiane', async () => {
  let clock = MONDAY;
  let ids;
  const t = await boot({ now: () => clock, seed: (f) => { ids = seedBoard(f); } });
  try {
    t.fake.failures.push({ re: new RegExp(`^GET /channels/${ids.a.id}/messages/${ids.a.id}$`), status: 400 });
    await t.app.bot.digestTick();
    assert.equal(t.fake.messagesOf(ID.ogolne).length, 0, 'niepełnych danych nie wysyłamy od razu');
    assert.ok(t.logs.error.some((l) => /Nie udało się pobrać części zadań/.test(l)));
    clock = new Date(MONDAY.getTime() + 11 * 60 * 1000);
    await t.app.bot.digestTick();
    const m = t.fake.messagesOf(ID.ogolne).find((x) => x.embeds.length);
    assert.match(fieldMap(m.embeds[0])['Po terminie (1)'], /Recenzja Gry A.*po terminie o 6 dni/s);
  } finally { await t.close(); }
});

test('zmiana statusu opiera się na świeżym stanie posta, nie na pamięci podręcznej bota', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    // Kierownik zmienia tag ręcznie w Discordzie, a bot nie dostaje zdarzenia (np. chwilowa przerwa połączenia).
    t.fake.thread(ids.c.id).applied_tags = [tagId('Opublikowane')];
    const ev = await t.fake.component(ID.autor, ids.c.id, 'kb:prev', { type: 2 });
    assert.match(ev.find((e) => e.kind === 'followup').body.content, /kierownictwo lub moderacja/);
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${ids.c.id}$`)).length, 0);
  } finally { await t.close(); }
});

test('dwa jednoczesne kliknięcia Dalej wykonują się po kolei, a nie nadpisują się', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    await Promise.all([
      t.fake.component(ID.autor, ids.c.id, 'kb:next', { type: 2 }),
      t.fake.component(ID.oliwia, ids.c.id, 'kb:next', { type: 2 }),
    ]);
    assert.ok(t.fake.thread(ids.c.id).applied_tags.includes(tagId('W pisaniu')), 'Pomysł -> Przydzielone -> W pisaniu');
  } finally { await t.close(); }
});

test('wybranie aktualnego statusu odświeża panel zamiast zostawiać stary napis', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    const ev = await t.fake.component(ID.autor, ids.a.id, 'kb:status', { values: ['W pisaniu'] });
    assert.equal(editOf(ev).content, 'Status: **W pisaniu**');
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\//).length, 0);
  } finally { await t.close(); }
});

test('post z 5 tagami tematu: bot niczego po cichu nie usuwa, tylko tłumaczy co zrobić', async () => {
  const five = ['Technologia', 'Planszówki', 'News', 'Evergreen', 'Cosplay i konwenty'];
  let th;
  const t = await boot({ now: () => NOW, seed: (f) => { th = f.addThread({ name: 'Dużo tagów', status: null, topics: five }); } });
  try {
    const ev = await t.fake.component(ID.autor, th.id, 'kb:next', { type: 2 });
    assert.match(ev.find((e) => e.kind === 'followup').body.content, /5 tagów tematu/);
    assert.equal(t.fake.requestsTo('PATCH', /^\/channels\//).length, 0);

    const fresh = t.fake.addThread({ name: 'Ręczny z 5 tagami', status: null, topics: five });
    t.fake.dispatch('THREAD_CREATE', { ...fresh, newly_created: true });
    await sleep(300);
    assert.equal(t.fake.messagesOf(fresh.id).filter((m) => m.components.length).length, 0);
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${fresh.id}$`)).length, 0);
    assert.ok(t.logs.warn.some((w) => /5 tagów tematu/.test(w)));
  } finally { await t.close(); }
});

test('/edytuj zmienia termin i osobę w dowolnym poście (też założonym ręcznie), odświeża kartę i tablicę, nie dotyka treści posta', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    await t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'Tekst do poprawy'), opt('osoba', ID.oliwia, 6), opt('termin', '05.11'), opt('opis', 'Źródła')]);
    const th = t.fake.created[0].thread;
    await waitFor(() => cardsIn(t.fake, th.id).length === 1);
    const board1 = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(board1).embeds[0])['Przydzielone (1)'], /05\.11, za 12 dni/);

    const ev = await t.fake.command(ID.szef, 'edytuj', [opt('termin', '10.11.2026'), opt('osoba', ID.autor, 6)], th.id);
    assert.match(editOf(ev).content, /Zaktualizowano zadanie/);
    assert.equal(t.fake.messagesOf(th.id)[0].content, 'Źródła', 'treść posta bez zmian');
    const card = cardsIn(t.fake, th.id)[0];
    assert.deepEqual(card.embeds[0].fields.map((f) => f.value), [`<@${ID.autor}>`, '10.11.2026', 'zwykły']);
    const board2 = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(board2).embeds[0])['Przydzielone (1)'], new RegExp(`<@${ID.autor}> · 10\\.11, za 17 dni`));

    await t.fake.command(ID.szef, 'edytuj', [opt('termin', 'brak')], th.id);
    assert.equal(cardsIn(t.fake, th.id)[0].embeds[0].fields[1].value, 'brak');
    const bad = await t.fake.command(ID.szef, 'edytuj', [opt('termin', 'kiedyś')], th.id);
    assert.match(editOf(bad).content, /Nie rozumiem terminu/);
    const none = await t.fake.command(ID.szef, 'edytuj', [], th.id);
    assert.match(editOf(none).content, /Podaj nowy termin, osobę albo wybierz „zwolnij”/);
    const both = await t.fake.command(ID.szef, 'edytuj', [opt('osoba', ID.autor, 6), opt('zwolnij', true, 5)], th.id);
    assert.match(editOf(both).content, /osobę albo „zwolnij”/);

    // post założony ręcznie przez człowieka też da się edytować (wcześniej bot odmawiał)
    const human = await t.fake.command(ID.autor, 'edytuj', [opt('termin', '10.11.2026')], ids.a.id);
    assert.match(editOf(human).content, /Zaktualizowano zadanie/);
    const hb = fieldMap(editOf(await t.fake.command(ID.autor, 'tablica')).embeds[0]);
    assert.match(hb['W pisaniu (1)'], /Recenzja Gry A.*10\.11, za 17 dni/, 'termin z karty wygrywa z linią w treści posta');
    assert.equal(t.fake.messagesOf(ids.a.id)[0].content, `Odpowiedzialny: <@${ID.oliwia}>\nTermin: 2026-10-20`, 'cudzej treści bot nie rusza');
  } finally { await t.close(); }
});

test('/edytuj zwolnij zdejmuje osobę (Przydzielone wraca do Pomysł), działa tylko w forum i tylko dla redakcji', async () => {
  const t = await boot({ now: () => NOW });
  try {
    await t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'Do zwolnienia'), opt('osoba', ID.oliwia, 6)]);
    const th = t.fake.created[0].thread;
    await waitFor(() => cardsIn(t.fake, th.id).length === 1);
    const ev = await t.fake.command(ID.szef, 'edytuj', [opt('zwolnij', true, 5)], th.id);
    assert.match(editOf(ev).content, /Zaktualizowano zadanie/);
    assert.ok(t.fake.thread(th.id).applied_tags.includes(tagId('Pomysł')));
    assert.ok(!t.fake.thread(th.id).applied_tags.includes(tagId('Przydzielone')));
    const card = cardsIn(t.fake, th.id)[0];
    assert.equal(card.content, 'Status: **Pomysł**');
    assert.equal(card.embeds[0].fields[0].value, 'brak, kliknij „Biorę to”');

    const elsewhere = t.fake.addThread({ name: 'Inny wątek', parent: ID.ogolne, status: null });
    const out = await t.fake.command(ID.autor, 'edytuj', [opt('termin', '10.11.2026')], elsewhere.id);
    assert.match(editOf(out).content, /tylko w postach na forum/);
    const editsBefore = (t.fake.edits || []).length;
    const stranger = await t.fake.command(ID.obcy, 'edytuj', [opt('termin', '10.11.2026')], th.id);
    assert.equal(editOf(stranger).content, 'Ta funkcja jest tylko dla redakcji.');
    assert.equal((t.fake.edits || []).length, editsBefore, 'obca osoba niczego nie zmieniła');
  } finally { await t.close(); }
});

test('nieznana komenda dostaje odpowiedź zamiast wiecznego "bot myśli"', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const ev = await t.fake.command(ID.autor, 'cokolwiek');
    assert.match(editOf(ev).content, /Nie znam tej komendy/);
  } finally { await t.close(); }
});

test('tytuł zadania jest przycinany do 100 znaków bez rozcinania emoji', async () => {
  const t = await boot({ now: () => NOW });
  try {
    await t.fake.command(ID.autor, 'zadanie', [opt('tytul', `${'a'.repeat(99)}😀😀`)]);
    const name = t.fake.created[0].body.name;
    assert.equal(Array.from(name).length, 100);
    assert.ok(name.endsWith('😀'));
    assert.ok(!/[\ud800-\udbff]$/.test(name), 'nie może kończyć się połową znaku');
  } finally { await t.close(); }
});

test('nieodwracalne zamknięcie bramki (np. zresetowany token) jest zgłaszane w logu i wywołuje onFatal', async () => {
  const t = await boot({ now: () => NOW });
  try {
    t.fake.closeSockets(4004, 'Authentication failed');
    const line = await waitFor(() => t.logs.error.find((l) => /kod 4004/.test(l)));
    assert.match(line, /token/i);
  } finally { await t.close(); }
});

test('termin zmieniony ręcznie w pierwszej wiadomości posta jest widoczny po wygaśnięciu pamięci podręcznej (5 min)', async () => {
  let clock = NOW;
  let ids;
  const t = await boot({ now: () => clock, seed: (f) => { ids = seedBoard(f); } });
  try {
    const before = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(before).embeds[0])['W pisaniu (1)'], /20\.10, po terminie o 4 dni/);
    // Autor poprawia termin w swoim poście. Bot nie ma intentu wiadomości serwerowych, więc nie dostaje zdarzenia o edycji.
    t.fake.messagesOf(ids.a.id)[0].content = `Odpowiedzialny: <@${ID.oliwia}>\nTermin: 2026-10-30`;
    clock = new Date(NOW.getTime() + 60 * 1000);
    const cached = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(cached).embeds[0])['W pisaniu (1)'], /20\.10/, 'w ciągu 5 minut obowiązuje pamięć podręczna');
    clock = new Date(NOW.getTime() + 6 * 60 * 1000);
    const after = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(after).embeds[0])['W pisaniu (1)'], /30\.10, za 6 dni/);
  } finally { await t.close(); }
});

test('nieudane pobranie terminu (błąd Discorda) nie jest zapamiętywane jako "brak terminu"', async () => {
  let ids;
  const t = await boot({ now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    t.fake.failures.push({ re: new RegExp(`^GET /channels/${ids.a.id}/messages/${ids.a.id}$`), status: 400 });
    const first = await t.fake.command(ID.autor, 'tablica');
    assert.match(editOf(first).embeds[0].footer.text, /Części terminów nie udało się pobrać/);
    assert.doesNotMatch(fieldMap(editOf(first).embeds[0])['W pisaniu (1)'], /po terminie/);
    const second = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(second).embeds[0])['W pisaniu (1)'], /po terminie o 4 dni/, 'kolejna próba od razu pobiera termin');
    assert.doesNotMatch(editOf(second).embeds[0].footer.text, /nie udało się pobrać/);
  } finally { await t.close(); }
});

test('podsumowanie: 403 przy pobieraniu wątków to błąd uprawnień zaliczany do końca dnia, bez skanowania co minutę', async () => {
  const t = await boot({ now: () => MONDAY, seed: seedBoard });
  try {
    t.fake.failures.push({ re: /^GET \/guilds\/\d+\/threads\/active/, status: 403 });
    await t.app.bot.digestTick();
    await t.app.bot.digestTick();
    assert.equal(t.fake.requestsTo('GET', /threads\/active$/).length, 1);
    assert.equal(t.logs.error.filter((l) => /Podsumowanie dnia pominięte/.test(l)).length, 1, t.logs.error.join('|'));
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).lastDigest, '2026-10-26');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- Runda 2: karta z przyciskami, okna, żywa tablica, filtry
const click = (t, user, channel, id, opts = {}) => t.fake.component(user, channel, id, { type: 2, ...opts });
const errorOf = (events) => events.find((e) => e.kind === 'followup')?.body;
const valuesOf = (card) => card.embeds[0].fields.map((f) => f.value);

async function newTask(t, args) {
  const before = (t.fake.created || []).length;
  await t.fake.command(ID.autor, 'zadanie', args);
  const th = t.fake.created[before].thread;
  await waitFor(() => cardsIn(t.fake, th.id).length === 1);
  return th;
}

test('„Biorę to” i „Zwolnij”: bierze wolne zadanie (Pomysł -> Przydzielone), cudzego nie przejmuje, zwalnia tylko właściciel', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Wolne zadanie')]);
    assert.deepEqual(flat(cardsIn(t.fake, th.id)[0]).filter((c) => c.type === 2).map((c) => c.custom_id), ['kb:prev', 'kb:go:Przydzielone', 'kb:take', 'kb:due', 'kb:urgent:on']);
    const taken = await click(t, ID.oliwia, th.id, 'kb:take');
    assert.equal(taken[0].type, 6, 'odroczona aktualizacja wiadomości z kartą');
    assert.equal(editOf(taken).content, 'Status: **Przydzielone**');
    assert.equal(editOf(taken).embeds[0].fields[0].value, `<@${ID.oliwia}>`);
    assert.deepEqual(flat(editOf(taken)).filter((c) => c.type === 2).map((c) => c.custom_id).slice(2, 3), ['kb:release'], 'przycisk zmienia się na „Zwolnij”');
    assert.ok(t.fake.thread(th.id).applied_tags.includes(tagId('Przydzielone')));
    assert.equal(t.fake.messagesOf(th.id).length, 2, 'bez pinga, gdy ktoś bierze zadanie sam');
    assert.equal(cardsIn(t.fake, th.id)[0].content, 'Status: **Przydzielone**', 'karta w poście też jest aktualna');

    // podwójne kliknięcie „Biorę to” (przycisk na starej karcie) niczego nie cofa
    const again = await click(t, ID.oliwia, th.id, 'kb:take');
    assert.equal(editOf(again).embeds[0].fields[0].value, `<@${ID.oliwia}>`, 'zadanie nadal jest moje');
    assert.ok(t.fake.thread(th.id).applied_tags.includes(tagId('Przydzielone')));

    const denied = await click(t, ID.autor, th.id, 'kb:take');
    assert.match(errorOf(denied).content, new RegExp(`ma już osobę: <@${ID.oliwia}>`));
    assert.equal(errorOf(denied).flags, EPHEMERAL);
    const notYours = await click(t, ID.autor, th.id, 'kb:release');
    assert.match(errorOf(notYours).content, /Zwolnić je może ona sama/);
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].a, ID.oliwia);

    const released = await click(t, ID.oliwia, th.id, 'kb:release');
    assert.equal(editOf(released).content, 'Status: **Pomysł**');
    assert.equal(editOf(released).embeds[0].fields[0].value, 'brak, kliknij „Biorę to”');
    assert.ok(t.fake.thread(th.id).applied_tags.includes(tagId('Pomysł')));
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].a, null);

    // podwójne kliknięcie „Zwolnij” też nic nie psuje
    const twice = await click(t, ID.oliwia, th.id, 'kb:release');
    assert.equal(editOf(twice).embeds[0].fields[0].value, 'brak, kliknij „Biorę to”');
    assert.equal(errorOf(twice), undefined);
  } finally { await t.close(); }
});

test('„Biorę to” w zadaniu na dalszym etapie nie rusza statusu; w poście z 5 tagami tematu przydział działa bez zmiany statusu', async () => {
  const five = ['Technologia', 'Planszówki', 'News', 'Evergreen', 'Cosplay i konwenty'];
  let writing; let crowded;
  const t = await boot({ now: () => NOW, seed: (f) => {
    writing = f.addThread({ name: 'W toku', owner: ID.app, status: 'W pisaniu' });
    crowded = f.addThread({ name: 'Dużo tagów', owner: ID.app, status: null, topics: five });
  } });
  try {
    const ev = await click(t, ID.oliwia, writing.id, 'kb:take');
    assert.equal(editOf(ev).content, 'Status: **W pisaniu**');
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${writing.id}$`)).length, 0, 'tagi bez zmian');

    const c = await click(t, ID.oliwia, crowded.id, 'kb:take');
    assert.equal(editOf(c).embeds[0].fields[0].value, `<@${ID.oliwia}>`);
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${crowded.id}$`)).length, 0, 'Discord pozwala na 5 tagów: statusu nie dopisujemy');
  } finally { await t.close(); }
});

test('menu „Przydziel osobę”: przydziela, pinguje tylko przydzielonego, odmawia osobom bez dostępu do forum i nieznanym', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Do przydziału')]);
    const ev = await t.fake.component(ID.autor, th.id, 'kb:assign', { type: 5, values: [ID.oliwia] });
    assert.equal(editOf(ev).content, 'Status: **Przydzielone**');
    assert.equal(editOf(ev).embeds[0].fields[0].value, `<@${ID.oliwia}>`);
    const ping = t.fake.messagesOf(th.id).find((m) => /teraz Twoje/.test(m.content));
    assert.deepEqual(ping.allowed_mentions, { users: [ID.oliwia] });
    assert.match(ping.content, new RegExp(`przydzielił\\(a\\): <@${ID.autor}>`));

    const patches = t.fake.requestsTo('PATCH', new RegExp(`^/channels/${th.id}$`)).length;
    const outsider = await t.fake.component(ID.autor, th.id, 'kb:assign', { type: 5, values: [ID.obcy] });
    assert.match(errorOf(outsider).content, /nie ma dostępu do forum zadań/);
    const ghost = await t.fake.component(ID.autor, th.id, 'kb:assign', { type: 5, values: ['100000000000009999'] });
    assert.match(errorOf(ghost).content, /nie ma jej na serwerze/);
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${th.id}$`)).length, patches, 'nieudany przydział niczego nie zmienia');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].a, ID.oliwia);
  } finally { await t.close(); }
});

test('osoba spoza redakcji nie kliknie żadnego przycisku na karcie', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Zamknięte')]);
    const edits = (t.fake.edits || []).length;
    for (const [id, opts] of [['kb:take', {}], ['kb:release', {}], ['kb:next', {}], ['kb:go:W pisaniu', {}], ['kb:urgent:on', {}], ['kb:status', { type: 3, values: ['W pisaniu'] }], ['kb:assign', { type: 5, values: [ID.autor] }]]) {
      const ev = await click(t, ID.obcy, th.id, id, opts);
      assert.equal(errorOf(ev).content, 'Ta funkcja jest tylko dla redakcji.', id);
    }
    const due = await click(t, ID.obcy, th.id, 'kb:due');
    assert.equal(due[0].type, 4, 'zwykła odpowiedź zamiast okna');
    assert.equal(due[0].data.content, 'Ta funkcja jest tylko dla redakcji.');
    assert.equal(due[0].data.flags, EPHEMERAL);
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${th.id}$`)).length, 0);
    assert.equal((t.fake.edits || []).length, edits);
  } finally { await t.close(); }
});

test('„Pilne”: ustawia priorytet (powtórne kliknięcie nic nie odwraca), zmienia przycisk, 🔥 na tablicy', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Gorące'), opt('osoba', ID.oliwia, 6)]);
    const on = await click(t, ID.autor, th.id, 'kb:urgent:on');
    assert.equal(editOf(on).embeds[0].fields[2].value, '🔥 pilne');
    const btn = flat(editOf(on)).find((c) => c.custom_id === 'kb:urgent:off');
    assert.equal(btn.label, 'Zdejmij pilne');
    const board = fieldMap(editOf(await t.fake.command(ID.autor, 'tablica')).embeds[0]);
    assert.match(board['Przydzielone (1)'], /🔥 \[Gorące\]/);
    const double = await click(t, ID.oliwia, th.id, 'kb:urgent:on'); // drugie kliknięcie tego samego przycisku
    assert.equal(editOf(double).embeds[0].fields[2].value, '🔥 pilne', 'nie przełącza z powrotem');
    const off = await click(t, ID.autor, th.id, 'kb:urgent:off');
    assert.equal(editOf(off).embeds[0].fields[2].value, 'zwykły');
    assert.ok(flat(editOf(off)).some((c) => c.custom_id === 'kb:urgent:on' && c.label === 'Pilne'));
    const doubleOff = await click(t, ID.autor, th.id, 'kb:urgent:off');
    assert.equal(editOf(doubleOff).embeds[0].fields[2].value, 'zwykły');
  } finally { await t.close(); }
});

test('przyciski Wstecz i Dalej niosą docelowy status, więc podwójne kliknięcie nie przesuwa dwa razy; na krańcach są wyłączone', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Początek')]);
    const nav = (card) => flat(card).filter((c) => c.type === 2).slice(0, 2).map((c) => [c.custom_id, !!c.disabled]);
    assert.deepEqual(nav(cardsIn(t.fake, th.id)[0]), [['kb:prev', true], ['kb:go:Przydzielone', false]]);

    const one = await click(t, ID.autor, th.id, 'kb:go:Przydzielone');
    assert.equal(editOf(one).content, 'Status: **Przydzielone**');
    assert.deepEqual(nav(editOf(one)), [['kb:go:Pomysł', false], ['kb:go:W pisaniu', false]]);
    const two = await click(t, ID.autor, th.id, 'kb:go:Przydzielone'); // to samo kliknięcie jeszcze raz
    assert.equal(editOf(two).content, 'Status: **Przydzielone**', 'drugi klik nie przesuwa dalej');
    assert.equal(t.fake.requestsTo('PATCH', new RegExp(`^/channels/${th.id}$`)).length, 1);

    const last = await t.fake.component(ID.szef, th.id, 'kb:status', { values: ['Opublikowane'] });
    assert.deepEqual(nav(editOf(last)), [['kb:go:Do publikacji', false], ['kb:next', true]]);
    const bad = await click(t, ID.autor, th.id, 'kb:go:Nie ma takiego');
    assert.match(errorOf(bad).content, /Nie ma takiego statusu/);
  } finally { await t.close(); }
});

test('„Termin”: okno z aktualnym terminem, zapis z karty, zły format i puste pole', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Z terminem')]);
    const open = await click(t, ID.autor, th.id, 'kb:due');
    assert.equal(open[0].type, 9, 'odpowiedź to okno (MODAL)');
    assert.equal(open[0].data.custom_id, 'kb:duemodal');
    assert.equal(open[0].data.components[0].type, 18, 'nowy format okna (Label)');
    assert.equal(open[0].data.components[0].component.custom_id, 'due');

    const ok = await t.fake.modalSubmit(ID.autor, th.id, 'kb:duemodal', { due: '05.11' });
    assert.equal(ok[0].type, 6);
    assert.equal(editOf(ok).embeds[0].fields[1].value, '05.11.2026');
    const board = fieldMap(editOf(await t.fake.command(ID.autor, 'tablica')).embeds[0]);
    assert.match(board['Pomysł (1)'], /05\.11, za 12 dni/);

    const reopen = await click(t, ID.autor, th.id, 'kb:due');
    assert.equal(reopen[0].data.components[0].component.value, '05.11.2026', 'okno podpowiada obecny termin');

    const bad = await t.fake.modalSubmit(ID.autor, th.id, 'kb:duemodal', { due: 'wkrótce' });
    assert.match(errorOf(bad).content, /Nie rozumiem terminu/);
    assert.equal(errorOf(bad).flags, EPHEMERAL);
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].d, '2026-11-05', 'zły format nie kasuje terminu');

    const cleared = await t.fake.modalSubmit(ID.autor, th.id, 'kb:duemodal', { due: '' });
    assert.equal(editOf(cleared).embeds[0].fields[1].value, 'brak');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].d, null, 'usunięty termin to jawne „brak”, a nie nieustawiony');
  } finally { await t.close(); }
});

test('okna: gdy Discord odrzuci nowy format, bot przechodzi na stary (pola w wierszach) i zapamiętuje to', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Stary format')]);
    t.fake.failures.push({ re: /^POST \/interactions\/\d+\/[^/]+\/callback$/, status: 400, code: 50035 });
    const open = await click(t, ID.autor, th.id, 'kb:due');
    assert.equal(open.filter((e) => e.kind === 'callback').length, 1, 'jedna udana odpowiedź po ponowieniu');
    assert.equal(open[0].type, 9);
    assert.equal(open[0].data.components[0].type, 1, 'wiersz akcji = stary format');
    assert.ok(t.logs.warn.some((w) => /Używam starego formatu/.test(w)), t.logs.warn.join('|'));

    const again = await click(t, ID.autor, th.id, 'kb:due');
    assert.equal(again[0].data.components[0].type, 1, 'kolejne okna od razu w starym formacie');

    const submit = await t.fake.modalSubmit(ID.autor, th.id, 'kb:duemodal', { due: '12.11.2026' }, { legacy: true });
    assert.equal(editOf(submit).embeds[0].fields[1].value, '12.11.2026');
  } finally { await t.close(); }
});

test('inny błąd (403) przy otwieraniu okna nie uruchamia trybu starego formatu', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Błąd 403')]);
    t.fake.failures.push({ re: /^POST \/interactions\/\d+\/[^/]+\/callback$/, status: 403 });
    await click(t, ID.autor, th.id, 'kb:due').catch(() => {});
    const next = await click(t, ID.autor, th.id, 'kb:due');
    assert.equal(next[0].data.components[0].type, 18, 'nadal nowy format');
    assert.ok(!t.logs.warn.some((w) => /starego formatu/.test(w)));
  } finally { await t.close(); }
});

const BOARD_ENV = { BOARD_DEBOUNCE_MS: '40' };
const boardMessages = (fake, ch = ID.ogolne) => fake.messagesOf(ch).filter((m) => m.embeds.length);

test('/ustaw-tablice: 7 wiadomości (nagłówek i 6 kolumn) w kolejności, z przyciskiem i filtrem; tylko kierownictwo, tylko kanał redakcji', async () => {
  const t = await boot({ env: BOARD_ENV, now: () => NOW, seed: seedBoard });
  try {
    const noRights = await t.fake.command(ID.autor, 'ustaw-tablice', [], ID.ogolne);
    assert.match(editOf(noRights).content, /ustawia kierownictwo lub moderacja/);
    assert.equal(boardMessages(t.fake).length, 0);
    const pub = await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.pogaduszki);
    assert.match(editOf(pub).content, /widoczny dla wszystkich/);
    assert.equal(t.fake.messagesOf(ID.pogaduszki).length, 0);
    const forum = await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.forum);
    assert.match(editOf(forum).content, /zwykłym kanale tekstowym/);
    const stranger = await t.fake.command(ID.obcy, 'ustaw-tablice', [], ID.ogolne);
    assert.equal(editOf(stranger).content, 'Żywą tablicę ustawia kierownictwo lub moderacja.', 'brak ManageThreads sprawdzany przed resztą');

    const ev = await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    assert.match(editOf(ev).content, /Gotowe/);
    const msgs = boardMessages(t.fake);
    assert.equal(msgs.length, 7);
    assert.equal(msgs[0].embeds[0].title, 'Tablica redakcji');
    assert.match(msgs[0].embeds[0].description, /\*\*Otwarte:\*\* 4 · \*\*Po terminie:\*\* 1 · \*\*Termin w 3 dni:\*\* 0/);
    assert.ok(msgs[0].embeds[0].timestamp, 'nagłówek pokazuje czas ostatniej aktualizacji');
    assert.deepEqual(flat(msgs[0]).map((c) => c.custom_id), ['kb:new', 'kb:filter']);
    assert.deepEqual(msgs.slice(1).map((m) => m.embeds[0].title), ['Pomysł · 1', 'Przydzielone · 0', 'W pisaniu · 1', 'Do redakcji · 1', 'Do publikacji · 1', 'Opublikowane · 1']);
    assert.match(msgs[3].embeds[0].description, /🔴 \[Recenzja Gry A\]/);
    assert.equal(msgs[3].embeds[0].color, 0xF1C40F);
    assert.ok(msgs.slice(1).every((m) => !m.components.length), 'kolumny nie mają przycisków');
    assert.ok(msgs.every((m) => JSON.stringify(m.allowed_mentions) === '{"parse":[]}'), 'tablica nikogo nie pinguje');
    const saved = JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).board;
    assert.equal(saved.channelId, ID.ogolne);
    assert.equal(saved.headerId, msgs[0].id);
    assert.equal(saved.columnIds['W pisaniu'], msgs[3].id);
  } finally { await t.close(); }
});

test('żywa tablica: zmiana statusu edytuje tylko kolumny, które się zmieniły (plus nagłówek), po jednym odświeżeniu na serię zmian', async () => {
  let ids;
  const t = await boot({ env: { BOARD_DEBOUNCE_MS: '600' }, now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const msgs = boardMessages(t.fake);
    const idOf = (title) => msgs.find((m) => m.embeds[0].title.startsWith(title)).id;
    const editsBefore = (t.fake.edits || []).length;
    const activeBefore = t.fake.requestsTo('GET', /threads\/active$/).length;

    // trzy zmiany pod rząd: Pomysł -> Przydzielone -> W pisaniu, oraz pilne
    await click(t, ID.autor, ids.c.id, 'kb:next');
    await click(t, ID.autor, ids.c.id, 'kb:next');
    await click(t, ID.autor, ids.c.id, 'kb:urgent:on');
    await waitFor(() => (t.fake.edits || []).some((e) => e.id === idOf('W pisaniu') && e.channelId === ID.ogolne));
    await sleep(200);
    const boardEdits = (t.fake.edits || []).slice(editsBefore).filter((e) => e.channelId === ID.ogolne);
    const edited = new Set(boardEdits.map((e) => e.id));
    assert.ok(edited.has(idOf('Pomysł')) && edited.has(idOf('W pisaniu')), 'kolumny, z których i do których przeszło zadanie');
    assert.ok(!edited.has(idOf('Do redakcji')) && !edited.has(idOf('Do publikacji')) && !edited.has(idOf('Opublikowane')), 'nietknięte kolumny nie są edytowane');
    assert.equal(t.fake.requestsTo('GET', /threads\/active$/).length - activeBefore, 1, 'seria zmian = jedno przeliczenie tablicy');
    const w = boardMessages(t.fake).find((m) => m.embeds[0].title.startsWith('W pisaniu'));
    assert.equal(w.embeds[0].title, 'W pisaniu · 2');
    assert.match(w.embeds[0].description, /🔥 \[Pomysł C\]/);
  } finally { await t.close(); }
});

test('żywa tablica: ręczna zmiana tagu, usunięcie posta i nowe zadanie odświeżają ją same; usunięty post znika też ze stanu', async () => {
  let ids;
  const t = await boot({ env: BOARD_ENV, now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const col = (title) => boardMessages(t.fake).find((m) => m.embeds[0].title.startsWith(title));

    // ktoś zmienia tag ręcznie w Discordzie
    t.fake.thread(ids.c.id).applied_tags = [tagId('Do redakcji')];
    t.fake.dispatch('THREAD_UPDATE', t.fake.thread(ids.c.id));
    await waitFor(() => col('Do redakcji').embeds[0].title === 'Do redakcji · 2');
    assert.equal(col('Do redakcji').embeds[0].title, 'Do redakcji · 2');
    assert.equal(col('Pomysł').embeds[0].title, 'Pomysł · 0');

    // nowe zadanie komendą
    await t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'Świeże')]);
    await waitFor(() => col('Pomysł').embeds[0].title === 'Pomysł · 1');
    assert.equal(col('Pomysł').embeds[0].title, 'Pomysł · 1');

    // usunięcie posta
    const created = t.fake.created[0].thread;
    assert.ok(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[created.id]);
    t.fake.threads.splice(t.fake.threads.indexOf(created), 1);
    t.fake.dispatch('THREAD_DELETE', { id: created.id, guild_id: ID.guild, parent_id: ID.forum, type: 11 });
    await waitFor(() => col('Pomysł').embeds[0].title === 'Pomysł · 0');
    assert.equal(col('Pomysł').embeds[0].title, 'Pomysł · 0');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[created.id], undefined, 'dane usuniętego zadania są czyszczone');
  } finally { await t.close(); }
});

test('żywa tablica: usunięta wiadomość kolumny, która się zmienia, powoduje pełną odbudowę w dobrej kolejności, bez duplikatów', async () => {
  const t = await boot({ env: BOARD_ENV, now: () => NOW, seed: seedBoard });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const first = boardMessages(t.fake);
    const victim = first[1]; // kolumna Pomysł, z której zaraz zniknie zadanie
    t.fake.messages.set(ID.ogolne, t.fake.messagesOf(ID.ogolne).filter((m) => m.id !== victim.id));
    await click(t, ID.autor, t.fake.threads.find((x) => x.name === 'Pomysł C').id, 'kb:next');
    await waitFor(() => boardMessages(t.fake).length === 7 && boardMessages(t.fake)[0].id !== first[0].id);
    const rebuilt = boardMessages(t.fake);
    assert.equal(rebuilt.length, 7, 'bez duplikatów');
    assert.deepEqual(rebuilt.map((m) => m.embeds[0].title.split(' · ')[0]), ['Tablica redakcji', 'Pomysł', 'Przydzielone', 'W pisaniu', 'Do redakcji', 'Do publikacji', 'Opublikowane']);
    assert.ok(rebuilt.every((m) => !first.some((o) => o.id === m.id)), 'wszystkie wiadomości wysłane od nowa');
    const saved = JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).board;
    assert.equal(saved.headerId, rebuilt[0].id);
    assert.equal(saved.columnIds.Opublikowane, rebuilt[6].id);
  } finally { await t.close(); }
});

test('żywa tablica: co 10 minut bot odświeża wszystkie wiadomości i wykrywa ręcznie usuniętą kolumnę, która się nie zmieniała', async () => {
  let clock = NOW;
  const t = await boot({ env: BOARD_ENV, now: () => clock, seed: seedBoard });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const first = boardMessages(t.fake);
    const victim = first[5]; // Do publikacji
    t.fake.messages.set(ID.ogolne, t.fake.messagesOf(ID.ogolne).filter((m) => m.id !== victim.id));
    const edits = (t.fake.edits || []).length;

    clock = new Date(NOW.getTime() + 5 * 60 * 1000);
    await t.app.bot.liveTick();
    assert.equal((t.fake.edits || []).length, edits, 'przed upływem 10 minut nic się nie dzieje');
    assert.equal(boardMessages(t.fake).length, 6);

    clock = new Date(NOW.getTime() + 11 * 60 * 1000);
    await t.app.bot.liveTick();
    const rebuilt = boardMessages(t.fake);
    assert.equal(rebuilt.length, 7, 'brakująca kolumna wróciła');
    assert.deepEqual(rebuilt.map((m) => m.embeds[0].title.split(' · ')[0]), ['Tablica redakcji', 'Pomysł', 'Przydzielone', 'W pisaniu', 'Do redakcji', 'Do publikacji', 'Opublikowane']);
    assert.match(rebuilt[0].embeds[0].timestamp, /^2026-10-24T10:11:00/, 'nagłówek pokazuje czas ostatniej aktualizacji');

    // kolejne tyknięcie tuż po pełnym odświeżeniu nie powtarza pracy
    const after = (t.fake.edits || []).length + t.fake.requestsTo('POST', new RegExp(`^/channels/${ID.ogolne}/messages$`)).length;
    clock = new Date(NOW.getTime() + 12 * 60 * 1000);
    await t.app.bot.liveTick();
    assert.equal((t.fake.edits || []).length + t.fake.requestsTo('POST', new RegExp(`^/channels/${ID.ogolne}/messages$`)).length, after);
  } finally { await t.close(); }
});

test('/ustaw-tablice na innym kanale przenosi tablicę (stara znika), a ponowne wywołanie w tym samym kanale nie dubluje', async () => {
  const t = await boot({ env: BOARD_ENV, now: () => NOW, seed: seedBoard });
  try {
    const other = t.fake.addTextChannel('tablica', { hidden: true });
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    assert.equal(boardMessages(t.fake).length, 7, 'ponowne ustawienie w tym samym kanale zastępuje tablicę');
    await t.fake.command(ID.szef, 'ustaw-tablice', [], other.id);
    assert.equal(boardMessages(t.fake, ID.ogolne).length, 0, 'stara tablica usunięta');
    assert.equal(boardMessages(t.fake, other.id).length, 7);
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).board.channelId, other.id);
  } finally { await t.close(); }
});

test('nagłówek tablicy: przycisk „Dodaj zadanie” otwiera formularz z listą osób, zgłoszenie tworzy zadanie z kartą i pingiem', async () => {
  const t = await boot({ env: BOARD_ENV, now: () => NOW });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const header = boardMessages(t.fake)[0];
    const open = await click(t, ID.autor, ID.ogolne, 'kb:new', { messageId: header.id });
    assert.equal(open[0].type, 9);
    assert.equal(open[0].data.custom_id, 'kb:newmodal');
    const comps = open[0].data.components;
    assert.deepEqual(comps.map((c) => [c.type, c.component.type, c.component.custom_id]), [[18, 4, 'title'], [18, 5, 'person'], [18, 4, 'due'], [18, 4, 'desc']]);
    assert.equal(comps[0].component.required, true);
    assert.equal(comps[1].component.required, false);

    const ev = await t.fake.modalSubmit(ID.autor, ID.ogolne, 'kb:newmodal', { title: 'Z formularza', person: [ID.oliwia], due: '12.11', desc: 'Opis z okna' }, { messageId: header.id });
    assert.equal(ev[0].type, 5, 'prywatna odpowiedź, nie aktualizacja nagłówka');
    assert.equal(ev[0].data.flags, EPHEMERAL);
    const { thread, body } = t.fake.created[0];
    assert.equal(body.name, 'Z formularza');
    assert.equal(body.message.content, 'Opis z okna');
    assert.deepEqual(body.applied_tags, [tagId('Przydzielone')]);
    assert.match(editOf(ev).content, new RegExp(`Dodano zadanie \\(termin 12\\.11\\.2026\\): ${url(thread.id)}`));
    await waitFor(() => cardsIn(t.fake, thread.id).length === 1 && t.fake.messagesOf(thread.id).length === 3);
    assert.deepEqual(valuesOf(cardsIn(t.fake, thread.id)[0]), [`<@${ID.oliwia}>`, '12.11.2026', 'zwykły']);
    await waitFor(() => boardMessages(t.fake).find((m) => m.embeds[0].title.startsWith('Przydzielone')).embeds[0].title === 'Przydzielone · 1');

    // bez osoby, bez terminu i bez opisu
    const min = await t.fake.modalSubmit(ID.autor, ID.ogolne, 'kb:newmodal', { title: 'Sam tytuł', person: [], due: '', desc: '' }, { messageId: header.id });
    assert.match(editOf(min).content, /Dodano zadanie/);
    assert.deepEqual(t.fake.created[1].body.applied_tags, [tagId('Pomysł')]);
    assert.equal(t.fake.created[1].body.message.content, `Zadanie dodane przez <@${ID.autor}>.`);

    // błędy formularza: pusty tytuł, zły termin, osoba bez dostępu
    const noTitle = await t.fake.modalSubmit(ID.autor, ID.ogolne, 'kb:newmodal', { title: '   ', person: [], due: '', desc: '' }, { messageId: header.id });
    assert.match(editOf(noTitle).content, /Podaj tytuł zadania/);
    const badDate = await t.fake.modalSubmit(ID.autor, ID.ogolne, 'kb:newmodal', { title: 'X', person: [], due: 'jutro', desc: '' }, { messageId: header.id });
    assert.match(editOf(badDate).content, /Nie rozumiem terminu/);
    const outsider = await t.fake.modalSubmit(ID.autor, ID.ogolne, 'kb:newmodal', { title: 'X', person: [ID.obcy], due: '', desc: '' }, { messageId: header.id });
    assert.match(editOf(outsider).content, /nie ma dostępu do forum/);
    assert.equal(t.fake.created.length, 2, 'błędne zgłoszenia nie tworzą postów');
  } finally { await t.close(); }
});

test('formularz nowego zadania w starym formacie (po odrzuceniu nowego przez Discorda) też tworzy zadanie', async () => {
  const t = await boot({ env: BOARD_ENV, now: () => NOW });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const header = boardMessages(t.fake)[0];
    t.fake.failures.push({ re: /^POST \/interactions\/\d+\/[^/]+\/callback$/, status: 400, code: 50035 });
    const open = await click(t, ID.autor, ID.ogolne, 'kb:new', { messageId: header.id });
    assert.deepEqual(open[0].data.components.map((c) => c.type), [1, 1, 1], 'tytuł, termin, opis w wierszach akcji');
    const ev = await t.fake.modalSubmit(ID.autor, ID.ogolne, 'kb:newmodal', { title: 'Stary formularz', due: '', desc: '' }, { legacy: true, messageId: header.id });
    assert.match(editOf(ev).content, /Dodano zadanie/);
    assert.equal(t.fake.created[0].body.name, 'Stary formularz');
  } finally { await t.close(); }
});

test('filtry na nagłówku: odpowiedź prywatna z listą zadań (Moje, Bez osoby, Po terminie, Pilne, Wszystkie otwarte)', async () => {
  let ids;
  const t = await boot({ env: BOARD_ENV, now: () => NOW, seed: (f) => {
    ids = seedBoard(f);
    ids.free = f.addThread({ name: 'Wolne i pilne', owner: ID.app, status: 'Pomysł', content: '' });
  } });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    await click(t, ID.autor, ids.free.id, 'kb:urgent:on');
    const header = boardMessages(t.fake)[0];
    const pick = (user, kind) => t.fake.component(user, ID.ogolne, 'kb:filter', { type: 3, values: [kind], messageId: header.id });

    const free = await pick(ID.autor, 'bez-osoby');
    assert.equal(free[0].type, 5);
    assert.equal(free[0].data.flags, EPHEMERAL, 'lista widoczna tylko dla klikającego');
    assert.equal(editOf(free).embeds[0].title, 'Bez osoby · 1');
    assert.match(editOf(free).embeds[0].description, /🔥 \[Wolne i pilne\].*\(Pomysł\).*bez osoby/);

    const mine = await pick(ID.oliwia, 'moje');
    assert.equal(editOf(mine).embeds[0].title, 'Moje zadania · 2');
    assert.doesNotMatch(editOf(mine).embeds[0].description, /Wolne i pilne|Pomysł C/);

    const late = await pick(ID.autor, 'po-terminie');
    assert.equal(editOf(late).embeds[0].title, 'Po terminie · 1');
    const urgent = await pick(ID.autor, 'pilne');
    assert.equal(editOf(urgent).embeds[0].title, 'Pilne · 1');
    const all = await pick(ID.autor, 'wszystkie');
    assert.equal(editOf(all).embeds[0].title, 'Wszystkie otwarte · 5');
    assert.doesNotMatch(editOf(all).embeds[0].description, /Stary D/, 'opublikowane pominięte');

    const stranger = await pick(ID.obcy, 'moje');
    assert.equal(editOf(stranger).content, 'Ta funkcja jest tylko dla redakcji.');
    const unknown = await pick(ID.autor, 'cokolwiek');
    assert.match(editOf(unknown).content, /Nie ma takiego widoku/);
  } finally { await t.close(); }
});

test('podsumowanie dnia: sekcja „Bez osoby, do wzięcia” pojawia się po zwolnieniu zadania', async () => {
  let clock = MONDAY;
  const t = await boot({ now: () => clock });
  try {
    const th = await newTask(t, [opt('tytul', 'Czeka na chętnego')]);
    await t.app.bot.digestTick();
    const msg = t.fake.messagesOf(ID.ogolne).find((m) => m.embeds.length);
    assert.deepEqual(Object.keys(fieldMap(msg.embeds[0])), ['Bez osoby, do wzięcia (1)']);
    assert.match(fieldMap(msg.embeds[0])['Bez osoby, do wzięcia (1)'], /Czeka na chętnego/);
    assert.equal(msg.content, '', 'sekcja bez osoby nikogo nie pinguje');
    assert.ok(th);
  } finally { await t.close(); }
});

test('karta usunięta ręcznie jest zakładana od nowa przy następnej zmianie komendą', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Karta zginęła')]);
    const card = cardsIn(t.fake, th.id)[0];
    t.fake.messages.set(th.id, t.fake.messagesOf(th.id).filter((m) => m.id !== card.id));
    await t.fake.command(ID.szef, 'edytuj', [opt('termin', '10.11.2026')], th.id);
    const cards = cardsIn(t.fake, th.id);
    assert.equal(cards.length, 1);
    assert.notEqual(cards[0].id, card.id);
    assert.equal(valuesOf(cards[0])[1], '10.11.2026');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].c, cards[0].id);
  } finally { await t.close(); }
});

test('klik na starej kopii karty aktualizuje też zarejestrowaną kartę w poście', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Dwie karty')]);
    const registered = cardsIn(t.fake, th.id)[0];
    const stale = t.fake.makeMessage(t.fake.newId(), th.id, ID.app, 'Status: **Pomysł**', { components: registered.components });
    t.fake.messages.get(th.id).push(stale);
    const ev = await click(t, ID.autor, th.id, 'kb:urgent:on', { messageId: stale.id });
    assert.equal(editOf(ev).embeds[0].fields[2].value, '🔥 pilne', 'klikana wiadomość');
    assert.equal(t.fake.messagesOf(th.id).find((m) => m.id === registered.id).embeds[0].fields[2].value, '🔥 pilne', 'zarejestrowana karta');
  } finally { await t.close(); }
});

test('nowy post założony ręcznie dostaje kartę zarejestrowaną w stanie, a późniejsza zmiana odświeża tę właśnie kartę', async () => {
  const t = await boot({ env: BOARD_ENV, now: () => NOW });
  try {
    const th = t.fake.addThread({ name: 'Ręczny', owner: ID.oliwia, status: null, content: 'treść' });
    t.fake.dispatch('THREAD_CREATE', { ...th, newly_created: true });
    await waitFor(() => cardsIn(t.fake, th.id).length === 1);
    const card = cardsIn(t.fake, th.id)[0];
    assert.equal(valuesOf(card)[0], `<@${ID.oliwia}>`, 'autor ręcznego posta jest domyślną osobą');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].c, card.id);
    await t.fake.command(ID.autor, 'edytuj', [opt('termin', '10.11.2026')], th.id);
    assert.equal(cardsIn(t.fake, th.id).length, 1);
    assert.equal(valuesOf(cardsIn(t.fake, th.id)[0])[1], '10.11.2026');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- poprawki po drugim, niezależnym przeglądzie
const { P: PERM } = require('./fake-discord');
const ROLE_COMMUNITY = '100000000000000777';
const addCommunity = (f) => {
  f.roles.push({ id: ROLE_COMMUNITY, name: 'Community', permissions: '0', position: 1, color: 0, hoist: false, managed: false, mentionable: false });
};

test('prywatność: kanał widoczny dla roli bez dostępu do forum (nie tylko dla @everyone) jest odrzucony przez /ustaw-tablice, /tablica publicznie i podsumowanie', async () => {
  let shared; let twin;
  const t = await boot({ env: { BOARD_DEBOUNCE_MS: '40', DIGEST_CHANNEL_NAME: 'wspolny' }, now: () => MONDAY, seed: (f) => {
    seedBoard(f);
    addCommunity(f);
    shared = f.addTextChannel('wspolny', { hidden: true });
    shared.permission_overwrites.push({ id: ROLE_COMMUNITY, type: 0, allow: String(PERM.VIEW), deny: '0' });
    twin = f.addTextChannel('redakcja-tylko', { hidden: true });
  } });
  try {
    const board = await t.fake.command(ID.szef, 'ustaw-tablice', [], shared.id);
    assert.match(editOf(board).content, /widoczny dla roli „Community”, która nie ma dostępu do forum/);
    assert.equal(t.fake.messagesOf(shared.id).length, 0);
    const pub = await t.fake.command(ID.autor, 'tablica', [opt('publicznie', true, 5)], shared.id);
    assert.match(editOf(pub).content, /nie widzą osoby spoza redakcji/);
    assert.equal(t.fake.messagesOf(shared.id).length, 0);
    await t.app.bot.digestTick();
    assert.equal(t.fake.messagesOf(shared.id).length, 0, 'podsumowanie nie trafia na kanał widoczny dla roli Community');
    assert.ok(t.logs.error.some((l) => /widoczny dla roli „Community”/.test(l)), t.logs.error.join('|'));

    const ok = await t.fake.command(ID.szef, 'ustaw-tablice', [], twin.id);
    assert.match(editOf(ok).content, /Gotowe/);
  } finally { await t.close(); }
});

test('prywatność: gdy po ustawieniu tablicy ktoś otworzy kanał dla innej roli, bot przestaje na nim pisać', async () => {
  let ch; let ids;
  const t = await boot({ env: { BOARD_DEBOUNCE_MS: '40' }, now: () => NOW, seed: (f) => { ids = seedBoard(f); addCommunity(f); ch = f.addTextChannel('tablica', { hidden: true }); } });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ch.id);
    assert.equal(boardMessages(t.fake, ch.id).length, 7);
    ch.permission_overwrites.push({ id: ROLE_COMMUNITY, type: 0, allow: String(PERM.VIEW), deny: '0' });
    t.fake.dispatch('CHANNEL_UPDATE', ch);
    await sleep(100);
    const edits = (t.fake.edits || []).length;
    await click(t, ID.autor, ids.c.id, 'kb:go:Przydzielone');
    await waitFor(() => t.logs.error.some((l) => /Żywa tablica wstrzymana: kanał jest widoczny dla roli „Community”/.test(l)));
    assert.ok(t.logs.error.some((l) => /Żywa tablica wstrzymana/.test(l)), t.logs.error.join('|'));
    assert.equal((t.fake.edits || []).slice(edits).filter((e) => e.channelId === ch.id).length, 0, 'tytuły nie trafiają na kanał widoczny dla obcych');
  } finally { await t.close(); }
});

test('/ustaw-tablice: współbieżne wywołania i zmiany nie zostawiają zbędnych wiadomości (zawsze dokładnie 7)', async () => {
  let ids;
  const t = await boot({ env: { BOARD_DEBOUNCE_MS: '20' }, now: () => NOW, seed: (f) => { ids = seedBoard(f); } });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    await Promise.all([
      t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne),
      click(t, ID.autor, ids.c.id, 'kb:go:Przydzielone'),
      t.fake.command(ID.autor, 'zadanie', [opt('tytul', 'W trakcie przebudowy')]),
      t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne),
    ]);
    t.fake.dispatch('THREAD_UPDATE', t.fake.thread(ids.a.id));
    await sleep(400);
    const msgs = boardMessages(t.fake);
    assert.equal(msgs.length, 7, `na kanale jest ${msgs.length} wiadomości tablicy`);
    const saved = JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).board;
    assert.deepEqual(msgs.map((m) => m.id), [saved.headerId, ...Object.values(saved.columnIds)].sort((a, b) => (a.length - b.length) || (a < b ? -1 : 1)));
  } finally { await t.close(); }
});

test('/ustaw-tablice na innym kanale: błąd w trakcie (pobranie danych albo wysyłka) zostawia starą tablicę nietkniętą i nie zostawia sierot', async () => {
  const t = await boot({ env: { BOARD_DEBOUNCE_MS: '40' }, now: () => NOW, seed: seedBoard });
  try {
    const other = t.fake.addTextChannel('nowa-tablica', { hidden: true });
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ID.ogolne);
    const before = boardMessages(t.fake).map((m) => m.id);
    const stateBefore = JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).board;

    t.fake.failures.push({ re: /^GET \/guilds\/\d+\/threads\/active/, status: 403 });
    const e1 = await t.fake.command(ID.szef, 'ustaw-tablice', [], other.id);
    assert.match(editOf(e1).content, /Coś poszło nie tak/);
    assert.deepEqual(boardMessages(t.fake).map((m) => m.id), before, 'stara tablica zostaje');
    assert.deepEqual(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).board, stateBefore);

    t.fake.failures.push({ re: new RegExp(`^POST /channels/${other.id}/messages$`), status: 403, after: 3 });
    const e2 = await t.fake.command(ID.szef, 'ustaw-tablice', [], other.id);
    assert.match(editOf(e2).content, /Brak uprawnień|nie ma wystarczających uprawnień|Coś poszło nie tak/);
    assert.equal(boardMessages(t.fake, other.id).length, 0, 'niedokończona nowa tablica jest sprzątana');
    assert.deepEqual(boardMessages(t.fake).map((m) => m.id), before, 'stara tablica nadal działa');
    assert.deepEqual(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).board, stateBefore);

    const ok = await t.fake.command(ID.szef, 'ustaw-tablice', [], other.id);
    assert.match(editOf(ok).content, /Gotowe/);
    assert.equal(boardMessages(t.fake, other.id).length, 7);
    assert.equal(boardMessages(t.fake, ID.ogolne).length, 0, 'stara usunięta dopiero po udanym przeniesieniu');
  } finally { await t.close(); }
});

test('błąd uprawnień przy pobieraniu kanału posta nie jest zgłaszany jako „zły kanał”', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Awaria odczytu')]);
    t.fake.failures.push({ re: new RegExp(`^GET /channels/${th.id}$`), status: 403, code: 50001 });
    const ev = await click(t, ID.autor, th.id, 'kb:take');
    assert.doesNotMatch(errorOf(ev).content, /tylko w postach na forum/);
    assert.match(errorOf(ev).content, /nie ma wystarczających uprawnień/);
    t.fake.failures.push({ re: new RegExp(`^GET /channels/${th.id}$`), status: 404, code: 10003 });
    const gone = await click(t, ID.autor, th.id, 'kb:take');
    assert.match(errorOf(gone).content, /tylko w postach na forum/, 'kanał, którego nie ma, to rzeczywiście zły adres');
  } finally { await t.close(); }
});

test('okno terminu podpowiada termin z treści ręcznego posta; zapisany na karcie ma pierwszeństwo', async () => {
  let manual;
  const t = await boot({ now: () => NOW, seed: (f) => { manual = f.addThread({ name: 'Ręczny z terminem', owner: ID.autor, status: 'W pisaniu', content: 'Termin: 2026-11-05' }); } });
  try {
    const open = await click(t, ID.autor, manual.id, 'kb:due');
    assert.equal(open[0].data.components[0].component.value, '05.11.2026');
    await t.fake.modalSubmit(ID.autor, manual.id, 'kb:duemodal', { due: '12.11' });
    const again = await click(t, ID.autor, manual.id, 'kb:due');
    assert.equal(again[0].data.components[0].component.value, '12.11.2026');
  } finally { await t.close(); }
});

test('/edytuj z błędną osobą nie zapisuje samego terminu (wszystko albo nic)', async () => {
  const t = await boot({ env: { BOARD_DEBOUNCE_MS: '40' }, now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Wszystko albo nic'), opt('termin', '05.11.2026')]);
    const ev = await t.fake.command(ID.szef, 'edytuj', [opt('termin', '20.11.2026'), opt('osoba', ID.obcy, 6)], th.id);
    assert.match(editOf(ev).content, /nie ma dostępu do forum/);
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].d, '2026-11-05');
    assert.equal(valuesOf(cardsIn(t.fake, th.id)[0])[1], '05.11.2026');
    const ok = await t.fake.command(ID.szef, 'edytuj', [opt('termin', '20.11.2026'), opt('osoba', ID.oliwia, 6)], th.id);
    assert.match(editOf(ok).content, /Zaktualizowano zadanie \(termin 20\.11\.2026\)/);
    const st = JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id];
    assert.deepEqual([st.a, st.d], [ID.oliwia, '2026-11-20']);
  } finally { await t.close(); }
});

test('zapisana zmiana dociera do tablicy i osoby także wtedy, gdy odświeżenie karty się nie uda; ta sama osoba nie dostaje drugiego pinga', async () => {
  let ch;
  const t = await boot({ env: { BOARD_DEBOUNCE_MS: '40' }, now: () => NOW, seed: (f) => { ch = f.addTextChannel('tablica', { hidden: true }); } });
  try {
    await t.fake.command(ID.szef, 'ustaw-tablice', [], ch.id);
    const th = await newTask(t, [opt('tytul', 'Karta nie odpowiada')]);
    const card = cardsIn(t.fake, th.id)[0];
    t.fake.failures.push({ re: new RegExp(`^PATCH /channels/${th.id}/messages/${card.id}$`), status: 403 });
    const ev = await t.fake.command(ID.szef, 'edytuj', [opt('osoba', ID.oliwia, 6)], th.id);
    assert.ok(editOf(ev).content, 'użytkownik dostaje komunikat');
    assert.equal(JSON.parse(fs.readFileSync(t.stateFile, 'utf8')).tasks[th.id].a, ID.oliwia, 'zmiana jest zapisana');
    assert.ok(t.fake.messagesOf(th.id).some((m) => /teraz Twoje/.test(m.content)), 'osoba i tak dostaje powiadomienie');
    await waitFor(() => boardMessages(t.fake, ch.id).find((m) => m.embeds[0].title.startsWith('Przydzielone')).embeds[0].title === 'Przydzielone · 1');
    assert.equal(boardMessages(t.fake, ch.id).find((m) => m.embeds[0].title.startsWith('Przydzielone')).embeds[0].title, 'Przydzielone · 1');

    const pings = () => t.fake.messagesOf(th.id).filter((m) => /teraz Twoje/.test(m.content)).length;
    const before = pings();
    await t.fake.component(ID.autor, th.id, 'kb:assign', { type: 5, values: [ID.oliwia] });
    assert.equal(pings(), before, 'ponowny wybór tej samej osoby nie pinguje drugi raz');
  } finally { await t.close(); }
});

test('przydział: osoba, która zdążyła opuścić serwer, nie przejdzie dzięki starej pamięci podręcznej', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Odeszła')]);
    const ok = await t.fake.component(ID.autor, th.id, 'kb:assign', { type: 5, values: [ID.oliwia] });
    assert.equal(editOf(ok).embeds[0].fields[0].value, `<@${ID.oliwia}>`);
    t.fake.knownUser = (id) => id !== ID.oliwia;
    const gone = await t.fake.component(ID.autor, th.id, 'kb:assign', { type: 5, values: [ID.oliwia] });
    assert.match(errorOf(gone).content, /nie ma jej na serwerze/);
  } finally { await t.close(); }
});

test('okna: błąd 40060 (interakcja już obsłużona) nie przełącza na stary format', async () => {
  const t = await boot({ now: () => NOW });
  try {
    const th = await newTask(t, [opt('tytul', 'Błąd 40060')]);
    t.fake.failures.push({ re: /^POST \/interactions\/\d+\/[^/]+\/callback$/, status: 400, code: 40060 });
    await click(t, ID.autor, th.id, 'kb:due');
    const next = await click(t, ID.autor, th.id, 'kb:due');
    assert.equal(next[0].data.components[0].type, 18);
    assert.ok(!t.logs.warn.some((w) => /starego formatu/.test(w)));
  } finally { await t.close(); }
});

test('oddanie tekstu przyciskiem zdejmuje „po terminie”, a cofnięcie do pisania je przywraca', async () => {
  let clock = NOW;
  const t = await boot({ now: () => clock });
  try {
    const th = await newTask(t, [opt('tytul', 'Recenzja do oddania'), opt('osoba', ID.oliwia, 6), opt('termin', '2026-10-26')]);
    const writing = await click(t, ID.oliwia, th.id, 'kb:go:W pisaniu');
    const buttons = flat(editOf(writing)).filter((c) => c.type === 2);
    assert.deepEqual([buttons[1].custom_id, buttons[1].label], ['kb:go:Do redakcji', 'Oddaj do redakcji ▶'], 'autor widzi wprost, że kończy pisanie');

    clock = new Date('2026-10-29T08:05:00Z'); // czwartek: termin minął trzy dni temu
    const late = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(late).embeds[0])['W pisaniu (1)'], /🔴 \[Recenzja do oddania\].*po terminie o 3 dni/);

    const handed = await click(t, ID.oliwia, th.id, 'kb:go:Do redakcji');
    assert.equal(editOf(handed).embeds[0].fields[1].value, '26.10.2026 · tekst oddany', 'karta w poście też nie straszy terminem');
    assert.ok(t.fake.thread(th.id).applied_tags.includes(tagId('Do redakcji')));
    const after = await t.fake.command(ID.autor, 'tablica');
    const col = fieldMap(editOf(after).embeds[0])['Do redakcji (1)'];
    assert.match(col, /📝 \[Recenzja do oddania\].*tekst oddany/);
    assert.doesNotMatch(col, /po terminie|🔴/);
    assert.match(editOf(after).embeds[0].fields.map((f) => f.value).join('\n'), /^(?![\s\S]*🔴)/, 'nigdzie na tablicy nie ma czerwonej kropki');

    await t.app.bot.digestTick();
    const digest = t.fake.messagesOf(ID.ogolne).find((m) => m.embeds.length);
    assert.deepEqual(Object.keys(fieldMap(digest.embeds[0])), ['Czeka na redakcję (1)'], 'oddany tekst czeka na redakcję i nie jest „po terminie”');

    // Redakcja odsyła tekst do poprawek: autor znowu jest po terminie.
    const back = await click(t, ID.oliwia, th.id, 'kb:go:W pisaniu');
    assert.equal(editOf(back).embeds[0].fields[1].value, '26.10.2026');
    const again = await t.fake.command(ID.autor, 'tablica');
    assert.match(fieldMap(editOf(again).embeds[0])['W pisaniu (1)'], /🔴 \[Recenzja do oddania\].*po terminie o 3 dni/);
  } finally { await t.close(); }
});
