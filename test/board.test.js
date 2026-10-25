'use strict';
// Autor: Mateusz Bartoszewicz
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/board');

const TAGS = [
  { id: '1', name: 'Pomysł' }, { id: '2', name: 'Przydzielone' }, { id: '3', name: 'W pisaniu' },
  { id: '4', name: 'Do redakcji' }, { id: '5', name: 'Do publikacji' }, { id: '6', name: 'Opublikowane' },
  { id: '10', name: 'Technologia' }, { id: '11', name: 'Planszówki' }, { id: '12', name: 'News' },
  { id: '13', name: 'Evergreen' }, { id: '14', name: 'Cosplay i konwenty' },
];
const st = B.statusTags(TAGS);

test('statusTags: znajduje wszystkie statusy bez względu na wielkość liter, zgłasza braki', () => {
  assert.equal(st.missing.length, 0);
  assert.equal(st.byName.get('W pisaniu').id, '3');
  const partial = B.statusTags([{ id: '1', name: 'pomysł' }, { id: '9', name: 'W PISANIU ' }]);
  assert.deepEqual(partial.missing, ['Przydzielone', 'Do redakcji', 'Do publikacji', 'Opublikowane']);
  assert.equal(partial.byName.get('Pomysł').id, '1');
  assert.equal(partial.byName.get('W pisaniu').id, '9');
});

test('currentStatus: najdalszy etap wygrywa, brak statusu to null', () => {
  assert.equal(B.currentStatus(['10', '3'], st), 'W pisaniu');
  assert.equal(B.currentStatus(['2', '4', '10'], st), 'Do redakcji');
  assert.equal(B.currentStatus(['10', '11'], st), null);
  assert.equal(B.currentStatus([], st), null);
  assert.equal(B.currentStatus(undefined, st), null);
});

test('withStatus: podmienia status, zostawia tematy, nigdy po cichu nie usuwa tagu', () => {
  assert.deepEqual(B.withStatus(['3', '10', '12'], st, 'Do redakcji'), ['10', '12', '4']);
  assert.deepEqual(B.withStatus([], st, 'Pomysł'), ['1']);
  assert.deepEqual(B.withStatus(['10', '11', '12', '13', '3'], st, 'Pomysł'), ['10', '11', '12', '13', '1'], '4 tematy + status mieści się w 5 tagach');
  assert.throws(() => B.withStatus(['10', '11', '12', '13', '14'], st, 'Pomysł'), /TOO_MANY_TOPIC_TAGS/);
  assert.throws(() => B.withStatus([], B.statusTags([]), 'Pomysł'), /Brak tagu/);
  assert.deepEqual(B.topicTags(['3', '10', '12'], st), ['10', '12']);
});

test('stepStatus: kolejne i poprzednie, końce zakresu', () => {
  assert.equal(B.stepStatus('Pomysł', 1), 'Przydzielone');
  assert.equal(B.stepStatus('Do redakcji', -1), 'W pisaniu');
  assert.equal(B.stepStatus('Pomysł', -1), null);
  assert.equal(B.stepStatus('Opublikowane', 1), null);
  assert.equal(B.stepStatus('cokolwiek', 1), null);
});

test('canMove: autor nie ustawia statusów końcowych ani ich nie cofa, kierownictwo może wszystko', () => {
  assert.equal(B.canMove('Pomysł', 'Przydzielone', false), true);
  assert.equal(B.canMove('Do redakcji', 'Do publikacji', false), false);
  assert.equal(B.canMove('Do publikacji', 'W pisaniu', false), false);
  assert.equal(B.canMove('Opublikowane', 'Pomysł', false), false);
  assert.equal(B.canMove('Pomysł', 'Opublikowane', false), false);
  assert.equal(B.canMove('Do redakcji', 'Do publikacji', true), true);
  assert.equal(B.canMove('Opublikowane', 'Pomysł', true), true);
});

test('normalizeDate: formaty, poprawność kalendarzowa, rok przestępny, najbliższa data bez roku', () => {
  assert.equal(B.normalizeDate('2026-11-05'), '2026-11-05');
  assert.equal(B.normalizeDate('5.11.2026'), '2026-11-05');
  assert.equal(B.normalizeDate('05.11.2026'), '2026-11-05');
  assert.equal(B.normalizeDate('2026-2-30'), null);
  assert.equal(B.normalizeDate('31.04.2026'), null);
  assert.equal(B.normalizeDate('29.02.2028'), '2028-02-29');
  assert.equal(B.normalizeDate('29.02.2027'), null);
  assert.equal(B.normalizeDate('05.11', '2026-10-24'), '2026-11-05');
  assert.equal(B.normalizeDate('05.11.', '2026-10-24'), '2026-11-05');
  assert.equal(B.normalizeDate('01.10', '2026-10-24'), '2027-10-01'); // minęło: za rok
  assert.equal(B.normalizeDate('24.10', '2026-10-24'), '2026-10-24'); // dziś zostaje dziś
  assert.equal(B.normalizeDate('05.11'), null); // bez daty odniesienia
  assert.equal(B.normalizeDate('jutro'), null);
  assert.equal(B.normalizeDate(''), null);
  assert.equal(B.normalizeDate(null), null);
});

test('daysBetween: przejście miesiąca, roku i zmiana czasu', () => {
  assert.equal(B.daysBetween('2026-10-24', '2026-10-25'), 1);
  assert.equal(B.daysBetween('2026-10-30', '2026-11-02'), 3);
  assert.equal(B.daysBetween('2026-12-30', '2027-01-02'), 3);
  assert.equal(B.daysBetween('2026-10-24', '2026-10-24'), 0);
  assert.equal(B.daysBetween('2026-11-05', '2026-11-01'), -4);
  assert.equal(B.daysBetween('2026-03-28', '2026-03-30'), 2);
});

test('parseMeta: osoba i termin z pierwszej wiadomości', () => {
  assert.deepEqual(B.parseMeta('Odpowiedzialny: <@123456789>\nTermin: 05.11.2026\n\nopis', '2026-10-24'),
    { assigneeId: '123456789', due: '2026-11-05' });
  assert.deepEqual(B.parseMeta('odpowiedzialna: <@!42>  termin: 2026-12-01', '2026-10-24'),
    { assigneeId: '42', due: '2026-12-01' });
  assert.deepEqual(B.parseMeta('Termin: **5.11**', '2026-10-24'), { assigneeId: null, due: '2026-11-05' });
  assert.deepEqual(B.parseMeta('Termin: wkrótce', '2026-10-24'), { assigneeId: null, due: null });
  assert.deepEqual(B.parseMeta('', '2026-10-24'), { assigneeId: null, due: null });
  assert.deepEqual(B.parseMeta(undefined, '2026-10-24'), { assigneeId: null, due: null });
});

test('buildStarterContent: opis albo informacja o autorze, bez linii Odpowiedzialny/Termin (osoba i termin żyją na karcie)', () => {
  assert.equal(B.buildStarterContent({ description: 'Opis zadania', authorId: '1' }), 'Opis zadania');
  assert.equal(B.buildStarterContent({ authorId: '9' }), 'Zadanie dodane przez <@9>.');
  assert.equal(B.buildStarterContent({ description: '', authorId: '9' }), 'Zadanie dodane przez <@9>.');
  assert.equal(B.buildStarterContent({ description: 'x'.repeat(5000), authorId: '9' }).length, 2000);
});

test('esc: znaki markdown w tytule nie psują linku', () => {
  assert.equal(B.esc('Recenzja [Gra] (beta) *test*'), 'Recenzja \\[Gra\\] \\(beta\\) \\*test\\*');
  assert.equal(B.esc('a\n\nb').includes('\n'), false);
  assert.equal(B.esc('x'.repeat(100)).length, 60);
});

test('whenLabel i taskLine', () => {
  assert.equal(B.whenLabel('2026-10-23', '2026-10-24'), 'po terminie o 1 dzień');
  assert.equal(B.whenLabel('2026-10-20', '2026-10-24'), 'po terminie o 4 dni');
  assert.equal(B.whenLabel('2026-10-24', '2026-10-24'), 'dziś');
  assert.equal(B.whenLabel('2026-10-25', '2026-10-24'), 'jutro');
  assert.equal(B.whenLabel('2026-10-28', '2026-10-24'), 'za 4 dni');
  const base = { name: 'Tekst', url: 'https://x/1', status: 'W pisaniu', assigneeId: '5', due: '2026-10-26' };
  assert.equal(B.taskLine(base, '2026-10-24', { showStatus: true }), '🟡 [Tekst](https://x/1) (W pisaniu) <@5> · 26.10, za 2 dni');
  assert.equal(B.taskLine({ ...base, urgent: true, due: '2026-10-20' }, '2026-10-24'), '🔴 🔥 [Tekst](https://x/1) <@5> · 20.10, po terminie o 4 dni');
  assert.equal(B.taskLine({ ...base, assigneeId: null, due: null }, '2026-10-24'), '⚪ [Tekst](https://x/1) · bez osoby');
  assert.equal(B.taskLine({ ...base, assigneeId: null, due: null, status: 'Opublikowane' }, '2026-10-24'), '✅ [Tekst](https://x/1)', 'opublikowane nie potrzebują osoby');
  assert.equal(B.taskLine({ ...base, status: 'Opublikowane', due: '2026-10-01', urgent: true }, '2026-10-24'), '✅ [Tekst](https://x/1) <@5>', 'opublikowane nie są „po terminie” ani pilne');
});

test('dueDot: kolor zależy od odległości terminu', () => {
  const d = (due) => B.dueDot(due, '2026-10-24');
  assert.equal(d(null), '⚪');
  assert.equal(d('2026-10-23'), '🔴');
  assert.equal(d('2026-10-24'), '🟠');
  assert.equal(d('2026-10-25'), '🟠');
  assert.equal(d('2026-10-26'), '🟡');
  assert.equal(d('2026-10-27'), '🟡');
  assert.equal(d('2026-10-28'), '🟢');
});

function mkTasks(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(1000 + i), name: `Zadanie numer ${i} z dosyć długim tytułem, żeby zająć miejsce`, url: `https://discord.com/channels/1/${1000 + i}`,
    status: B.STATUSES[i % B.STATUSES.length], assigneeId: '123456789012345678', due: i % 3 === 0 ? '2026-11-05' : null, ...over,
  }));
}

test('renderBoard: kolejność kolumn, liczniki, Opublikowane ograniczone do 3', () => {
  const tasks = [
    { id: '1', name: 'A', url: 'u1', status: 'Pomysł', assigneeId: null, due: null },
    { id: '2', name: 'B', url: 'u2', status: 'Pomysł', assigneeId: null, due: '2026-10-30' },
    { id: '3', name: 'C', url: 'u3', status: 'Opublikowane', assigneeId: null, due: null },
    { id: '4', name: 'D', url: 'u4', status: 'Opublikowane', assigneeId: null, due: null },
    { id: '5', name: 'E', url: 'u5', status: 'Opublikowane', assigneeId: null, due: null },
    { id: '6', name: 'F', url: 'u6', status: 'Opublikowane', assigneeId: null, due: null },
  ];
  const e = B.renderBoard(tasks, '2026-10-24');
  assert.deepEqual(e.fields.map((f) => f.name), [
    'Pomysł (2)', 'Przydzielone (0)', 'W pisaniu (0)', 'Do redakcji (0)', 'Do publikacji (0)', 'Opublikowane (4)']);
  assert.match(e.fields[0].value, /\[B\].*\n.*\[A\]/s, 'z terminem przed bez terminu');
  assert.match(e.fields[5].value, /\[F\].*\[E\].*\[D\].*… i 1 więcej/s, 'najnowsze na górze, 3 pozycje');
  assert.equal(e.fields[1].value, '—');
  assert.ok(e.fields.every((f) => f.inline === false));
});

test('renderBoard: moje zadania, pusty stan', () => {
  const tasks = [
    { id: '1', name: 'Moje', url: 'u', status: 'W pisaniu', assigneeId: '5', due: null },
    { id: '2', name: 'Cudze', url: 'u', status: 'W pisaniu', assigneeId: '6', due: null },
  ];
  const mine = B.renderBoard(tasks, '2026-10-24', { onlyUserId: '5' });
  assert.equal(mine.title, 'Tablica: moje zadania');
  assert.equal(mine.fields.length, 1);
  assert.match(mine.fields[0].value, /Moje/);
  assert.doesNotMatch(JSON.stringify(mine), /Cudze/);
  const none = B.renderBoard(tasks, '2026-10-24', { onlyUserId: '99' });
  assert.equal(none.description, 'Brak zadań.');
  assert.equal(B.renderBoard([], '2026-10-24').description, 'Brak zadań.');
});

test('renderBoard: limity Discorda (pole <= 1024, embed <= 6000) także przy 300 zadaniach', () => {
  const e = B.renderBoard(mkTasks(300), '2026-10-24');
  assert.ok(e.fields.every((f) => f.value.length <= 1024 && f.name.length <= 256), 'pole za długie');
  const total = e.title.length + e.footer.text.length + e.fields.reduce((s, f) => s + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `embed ma ${total} znaków`);
  assert.ok(e.fields.some((f) => /… i \d+ więcej/.test(f.value)));
});

test('renderDigest: null gdy nic do pokazania, sekcje, Opublikowane pominięte, osoby bez duplikatów', () => {
  assert.equal(B.renderDigest([], '2026-10-24'), null);
  assert.equal(B.renderDigest([{ id: '1', name: 'A', url: 'u', status: 'W pisaniu', assigneeId: '5', due: null }], '2026-10-24'), null);
  const tasks = [
    { id: '1', name: 'Spóźnione', url: 'u1', status: 'W pisaniu', assigneeId: '5', due: '2026-10-20' },
    { id: '2', name: 'Wkrótce', url: 'u2', status: 'Przydzielone', assigneeId: '5', due: '2026-10-26' },
    { id: '3', name: 'Daleko', url: 'u3', status: 'Przydzielone', assigneeId: '7', due: '2026-12-01' },
    { id: '4', name: 'Hotowe', url: 'u4', status: 'Opublikowane', assigneeId: '8', due: '2026-10-01' },
    { id: '5', name: 'Redakcja', url: 'u5', status: 'Do redakcji', assigneeId: '9', due: null },
    { id: '6', name: 'Publikacja', url: 'u6', status: 'Do publikacji', assigneeId: null, due: null },
  ];
  const d = B.renderDigest(tasks, '2026-10-24');
  assert.deepEqual(d.embed.fields.map((f) => f.name),
    ['Po terminie (1)', 'Termin w ciągu 3 dni (1)', 'Czeka na redakcję (1)', 'Gotowe do publikacji (1)']);
  assert.doesNotMatch(JSON.stringify(d), /Hotowe|Daleko/);
  assert.deepEqual(d.pingIds, ['5']);
  assert.doesNotMatch(JSON.stringify(d.embed.fields.filter((f) => /Bez osoby/.test(f.name))), /Publikacja/, 'zadanie do publikacji ma własną sekcję');
});

test('renderDigest: sekcja „Bez osoby, do wzięcia” pokazuje wolne zadania, bez pingów, max 8 wierszy', () => {
  const free = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), name: `Wolne ${i}`, url: `u${i}`, status: i % 2 ? 'Pomysł' : 'W pisaniu', assigneeId: null, due: null }));
  const d = B.renderDigest(free, '2026-10-24');
  assert.deepEqual(d.embed.fields.map((f) => f.name), ['Bez osoby, do wzięcia (12)']);
  assert.match(d.embed.fields[0].value, /… i 4 więcej/);
  assert.equal(d.embed.fields[0].value.split('\n').length, 9, '8 zadań i wiersz „i N więcej”');
  assert.deepEqual(d.pingIds, []);
});

test('shouldSendDigest: godzina, okno, weekend, już wysłane, strefa czasowa', () => {
  const base = { timeZone: 'Europe/Warsaw', hour: 9, weekdays: [1, 2, 3, 4, 5], lastSentIso: null };
  // pon. 2026-10-26, po zmianie czasu na zimowy (UTC+1): 08:00Z = 09:00
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-26T07:59:00Z') }), false);
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-26T08:00:00Z') }), true);
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-26T13:59:00Z') }), true);
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-26T14:00:00Z') }), false, 'okno 6 godzin minęło');
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-26T08:30:00Z'), lastSentIso: '2026-10-26' }), false);
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-26T08:30:00Z'), lastSentIso: '2026-10-23' }), true);
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-24T08:30:00Z') }), false, 'sobota');
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-10-25T08:30:00Z') }), false, 'niedziela');
  // lato (UTC+2): 07:00Z = 09:00
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-07-01T07:00:00Z') }), true);
  assert.equal(B.shouldSendDigest({ ...base, now: new Date('2026-07-01T06:59:00Z') }), false);
  // północ po polsku to 22:00Z/23:00Z poprzedniego dnia UTC
  assert.equal(B.todayIn('Europe/Warsaw', new Date('2026-10-26T23:30:00Z')), '2026-10-27');
});

test('parseMeta: data bez roku w ręcznym poście to rok najbliższy dzisiejszej dacie (także przeszłość)', () => {
  assert.equal(B.parseMeta('Termin: 05.11', '2026-11-06').due, '2026-11-05', 'wczoraj, a nie za rok');
  assert.equal(B.parseMeta('Termin: 05.01', '2026-12-20').due, '2027-01-05', 'styczeń po grudniu to przyszłość');
  assert.equal(B.parseMeta('Termin: 20.12', '2027-01-03').due, '2026-12-20', 'grudzień po sylwestrze to niedawna przeszłość');
  assert.equal(B.parseMeta('**Termin**: 05.11.2026', '2026-11-06').due, '2026-11-05', 'pogrubiona etykieta');
  assert.equal(B.parseMeta('__Odpowiedzialny__: <@123>', '2026-11-06').assigneeId, '123');
  // Komenda /zadanie nadal szuka najbliższego terminu w przyszłości.
  assert.equal(B.normalizeDate('05.11', '2026-11-06'), '2027-11-05');
});

test('esc: nie rozcina emoji (para zastępcza UTF-16) na granicy 60 znaków', () => {
  const out = B.esc(`${'a'.repeat(59)}😀x`);
  assert.equal(Array.from(out).length, 60);
  assert.ok(out.endsWith('😀'));
  assert.ok(!/[\ud800-\udbff]$/.test(out));
});

test('todayIn: data w strefie Europe/Warsaw, także tuż po północy czasu lokalnego i przy zmianie czasu', () => {
  assert.equal(B.todayIn('Europe/Warsaw', new Date('2026-10-24T23:30:00Z')), '2026-10-25');
  assert.equal(B.todayIn('Europe/Warsaw', new Date('2026-10-24T21:59:00Z')), '2026-10-24');
  assert.equal(B.todayIn('Europe/Warsaw', new Date('2026-03-29T00:30:00Z')), '2026-03-29');
});

test('compareTasks: pilne najpierw, potem termin rosnąco, potem bez terminu, potem kolejność zakładania', () => {
  const mk = (id, due, urgent = false) => ({ id, due, urgent });
  const sorted = [mk('4', null), mk('3', '2026-11-01'), mk('2', '2026-10-30'), mk('9', '2026-12-01', true), mk('10', null)].sort(B.compareTasks);
  assert.deepEqual(sorted.map((t) => t.id), ['9', '2', '3', '4', '10']);
});

test('renderColumn: tytuł z licznikiem, kolor statusu, Opublikowane ograniczone do 5, długa kolumna mieści się w opisie embeda', () => {
  const mk = (i, status, over = {}) => ({ id: String(1000 + i), name: `Zadanie ${i}`, url: `u${i}`, status, assigneeId: '5', due: null, ...over });
  const pub = Array.from({ length: 8 }, (_, i) => mk(i, 'Opublikowane'));
  const col = B.renderColumn('Opublikowane', pub, '2026-10-24');
  assert.equal(col.title, 'Opublikowane · 8');
  assert.equal(col.color, B.STATUS_COLORS.Opublikowane);
  assert.equal(col.description.split('\n').length, 6, '5 zadań i wiersz „i 3 więcej”');
  assert.match(col.description, /… i 3 więcej/);
  assert.match(col.description, /Zadanie 7/, 'najnowsze na górze');
  const empty = B.renderColumn('Pomysł', [], '2026-10-24');
  assert.deepEqual([empty.title, empty.description], ['Pomysł · 0', '—']);
  const many = Array.from({ length: 200 }, (_, i) => mk(i, 'W pisaniu', { name: `Bardzo długi tytuł zadania numer ${i} który zajmuje miejsce`, due: '2026-11-05' }));
  const big = B.renderColumn('W pisaniu', many, '2026-10-24');
  assert.ok(big.description.length <= 4096, `opis ma ${big.description.length} znaków`);
  assert.match(big.description, /… i \d+ więcej/);
  assert.equal(B.renderColumn('W pisaniu', many, '2026-10-24').title, 'W pisaniu · 200');
});

test('summaryCounts i renderHeader: liczniki otwartych, po terminie, w 3 dni, bez osoby i pilnych (Opublikowane nie liczą się)', () => {
  const tasks = [
    { id: '1', name: 'A', url: 'u', status: 'W pisaniu', assigneeId: '5', due: '2026-10-20' },
    { id: '2', name: 'B', url: 'u', status: 'Pomysł', assigneeId: null, due: '2026-10-26', urgent: true },
    { id: '3', name: 'C', url: 'u', status: 'Opublikowane', assigneeId: null, due: '2026-10-01', urgent: true },
    { id: '4', name: 'D', url: 'u', status: 'Do redakcji', assigneeId: '6', due: null },
  ];
  assert.deepEqual(B.summaryCounts(tasks, '2026-10-24'), { open: 3, overdue: 1, soon: 1, unassigned: 1, urgent: 1 });
  const h = B.renderHeader(tasks, '2026-10-24', { note: 'Uwaga testowa' });
  assert.match(h.description, /\*\*Otwarte:\*\* 3 · \*\*Po terminie:\*\* 1 · \*\*Termin w 3 dni:\*\* 1 · \*\*Bez osoby:\*\* 1 · \*\*Pilne:\*\* 1/);
  assert.match(h.description, /Uwaga testowa/);
  assert.match(h.description, /🔴 po terminie/);
});

test('filterTasks i renderList: widoki Moje, Bez osoby, Po terminie, Pilne, Wszystkie; Opublikowane zawsze pominięte', () => {
  const tasks = [
    { id: '1', name: 'Moje', url: 'u1', status: 'W pisaniu', assigneeId: '5', due: '2026-10-20' },
    { id: '2', name: 'Wolne', url: 'u2', status: 'Pomysł', assigneeId: null, due: null, urgent: true },
    { id: '3', name: 'Cudze', url: 'u3', status: 'Do redakcji', assigneeId: '6', due: null },
    { id: '4', name: 'Gotowe', url: 'u4', status: 'Opublikowane', assigneeId: '5', due: '2026-10-01', urgent: true },
  ];
  const names = (kind, uid = '5') => B.filterTasks(tasks, kind, uid, '2026-10-24').map((t) => t.name);
  assert.deepEqual(names('moje'), ['Moje']);
  assert.deepEqual(names('bez-osoby'), ['Wolne']);
  assert.deepEqual(names('po-terminie'), ['Moje']);
  assert.deepEqual(names('pilne'), ['Wolne']);
  assert.deepEqual(names('wszystkie'), ['Moje', 'Wolne', 'Cudze']);
  const list = B.renderList(B.FILTERS['bez-osoby'], B.filterTasks(tasks, 'bez-osoby', '5', '2026-10-24'), '2026-10-24');
  assert.equal(list.title, 'Bez osoby · 1');
  assert.match(list.description, /Wolne.*\(Pomysł\)/);
  assert.equal(list.footer, undefined, 'bez uwagi nie ma stopki');
  assert.equal(B.renderList('Pusto', [], '2026-10-24').description, 'Nic tu nie ma.');
});

test('Opublikowane: najnowszy post na górze niezależnie od terminu i priorytetu (kolumna, /tablica)', () => {
  const mk = (id, over = {}) => ({ id, name: `P${id}`, url: `u${id}`, status: 'Opublikowane', assigneeId: null, due: null, ...over });
  const tasks = [mk('1001'), mk('1002'), mk('1003'), mk('1004'), mk('1005'), mk('1006', { due: '2026-10-01', urgent: true }), mk('1007')];
  const col = B.renderColumn('Opublikowane', tasks, '2026-10-24');
  const lines = col.description.split('\n');
  assert.match(lines[0], /P1007/);
  assert.match(lines[1], /P1006/, 'z terminem i pilne, ale nie wypchnięte na koniec');
  assert.match(lines[4], /P1003/);
  assert.match(lines[5], /… i 2 więcej/);
  assert.doesNotMatch(col.description, /P1001/);
  const board = B.renderBoard(tasks, '2026-10-24');
  const field = board.fields.find((f) => f.name.startsWith('Opublikowane'));
  assert.match(field.value.split('\n')[0], /P1007/);
  assert.doesNotMatch(field.value.split('\n')[1], /po terminie/);
});

// ---------------------------------------------------------------- zakończone pisanie (oddany tekst)
test('isWritingDone: oddany tekst to Do redakcji, Do publikacji i Opublikowane', () => {
  assert.deepEqual(B.STATUSES.filter(B.isWritingDone), ['Do redakcji', 'Do publikacji', 'Opublikowane']);
  assert.equal(B.isWritingDone('W pisaniu'), false);
  assert.equal(B.isWritingDone(undefined), false);
});

test('taskLine: oddany tekst nie jest „po terminie”, ma 📝 i zachowuje pilność; w pisaniu po terminie nadal jest czerwone', () => {
  const base = { id: '1', name: 'Tekst', url: 'https://x/1', assigneeId: '5', due: '2026-10-20', urgent: false };
  const today = '2026-10-24';
  assert.equal(B.taskLine({ ...base, status: 'W pisaniu' }, today), '🔴 [Tekst](https://x/1) <@5> · 20.10, po terminie o 4 dni');
  assert.equal(B.taskLine({ ...base, status: 'Do redakcji' }, today), '📝 [Tekst](https://x/1) <@5> · tekst oddany');
  assert.equal(B.taskLine({ ...base, status: 'Do publikacji', urgent: true }, today), '📝 🔥 [Tekst](https://x/1) <@5> · tekst oddany', 'pilne dalej wypycha tekst na górę kolumny');
  assert.equal(B.taskLine({ ...base, status: 'Do redakcji', due: null, assigneeId: null }, today), '📝 [Tekst](https://x/1) · bez osoby · tekst oddany');
  assert.equal(B.taskLine({ ...base, status: 'Opublikowane' }, today), '✅ [Tekst](https://x/1) <@5>', 'opublikowane bez zmian');
});

test('summaryCounts i filterTasks: oddane teksty nie liczą się do „po terminie” ani „w 3 dni”, ale są otwarte', () => {
  const mk = (id, status, due) => ({ id, name: `T${id}`, url: `u${id}`, status, assigneeId: '5', due });
  const tasks = [mk('1', 'W pisaniu', '2026-10-20'), mk('2', 'Do redakcji', '2026-10-20'), mk('3', 'Do publikacji', '2026-10-25'), mk('4', 'W pisaniu', '2026-10-25')];
  assert.deepEqual(B.summaryCounts(tasks, '2026-10-24'), { open: 4, overdue: 1, soon: 1, unassigned: 0, urgent: 0 });
  assert.deepEqual(B.filterTasks(tasks, 'po-terminie', '5', '2026-10-24').map((t) => t.id), ['1']);
  assert.equal(B.filterTasks(tasks, 'wszystkie', '5', '2026-10-24').length, 4, 'oddane teksty nadal są otwarte');
  assert.match(B.renderHeader(tasks, '2026-10-24').description, /\*\*Po terminie:\*\* 1 · \*\*Termin w 3 dni:\*\* 1/);
  assert.match(B.renderHeader(tasks, '2026-10-24').description, /📝 tekst oddany/, 'legenda wyjaśnia ikonę');
});

test('renderDigest: oddane teksty trafiają tylko do sekcji redakcji i publikacji, a pingi dostają wyłącznie autorzy tekstów w pisaniu', () => {
  const mk = (id, status, due, assigneeId) => ({ id, name: `T${id}`, url: `u${id}`, status, assigneeId, due });
  const tasks = [mk('1', 'W pisaniu', '2026-10-20', '7'), mk('2', 'Do redakcji', '2026-10-20', '8'), mk('3', 'Do publikacji', '2026-10-24', '9')];
  const s = B.digestSections(tasks, '2026-10-24');
  assert.deepEqual(s.overdue.map((t) => t.id), ['1']);
  assert.deepEqual(s.soon, []);
  assert.deepEqual(s.review.map((t) => t.id), ['2']);
  assert.deepEqual(s.ready.map((t) => t.id), ['3']);
  const d = B.renderDigest(tasks, '2026-10-24');
  assert.deepEqual(d.embed.fields.map((f) => f.name), ['Po terminie (1)', 'Czeka na redakcję (1)', 'Gotowe do publikacji (1)']);
  assert.deepEqual(d.pingIds, ['7']);
  // Sam oddany tekst nie daje podsumowania: nic nie jest „po terminie”, a sekcje redakcji i publikacji i tak go pokażą.
  assert.deepEqual(B.renderDigest([mk('2', 'Do redakcji', '2026-10-20', '8')], '2026-10-24').pingIds, []);
});

test('cardPayload: przycisk przy „W pisaniu” nazywa się „Oddaj do redakcji”, pole Termin pokazuje „tekst oddany”', () => {
  const { cardPayload } = require('../src/ui');
  const label = (card, i) => card.components[1].components[i].toJSON().label;
  const writing = cardPayload({ status: 'W pisaniu', assigneeId: '5', due: '2026-10-20', urgent: false });
  assert.equal(label(writing, 1), 'Oddaj do redakcji ▶');
  assert.equal(writing.components[1].components[1].toJSON().custom_id, 'kb:go:Do redakcji');
  assert.equal(writing.embeds[0].fields[1].value, B.fmtDate('2026-10-20'));
  const earlier = cardPayload({ status: 'Przydzielone', assigneeId: '5', due: null, urgent: false });
  assert.equal(label(earlier, 1), 'Dalej ▶', 'z Przydzielone następny jest W pisaniu, nie oddanie');
  const handed = cardPayload({ status: 'Do redakcji', assigneeId: '5', due: '2026-10-20', urgent: false });
  assert.equal(label(handed, 1), 'Dalej ▶');
  assert.equal(handed.embeds[0].fields[1].value, `${B.fmtDate('2026-10-20')} · tekst oddany`);
  assert.equal(cardPayload({ status: 'Do publikacji', assigneeId: null, due: null, urgent: false }).embeds[0].fields[1].value, 'tekst oddany');
});
