'use strict';
// Autor: Mateusz Bartoszewicz
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/finance');

test('parseMoney: przyjmuje zwykłe zapisy kwot i zwraca grosze', () => {
  assert.equal(F.parseMoney('120'), 12000);
  assert.equal(F.parseMoney('120,5'), 12050);
  assert.equal(F.parseMoney('120,50'), 12050);
  assert.equal(F.parseMoney('120.50'), 12050);
  assert.equal(F.parseMoney('0,99'), 99);
  assert.equal(F.parseMoney('1 200,50'), 120050);
  assert.equal(F.parseMoney('1 200,50 zł'), 120050);
  assert.equal(F.parseMoney(' 80 PLN '), 8000);
  assert.equal(F.parseMoney('80zl'), 8000);
});

test('parseMoney: odrzuca śmieci, wartości ujemne, trzy miejsca po przecinku i absurdalne kwoty', () => {
  for (const bad of ['', '   ', 'abc', '-5', '12,345', '1,2,3', ',50', '12 zł zł', '1e3', null, undefined, '100000,01', '99999999999999999999']) {
    assert.equal(F.parseMoney(bad), null, `powinno odrzucić ${JSON.stringify(bad)}`);
  }
  assert.equal(F.parseMoney('100000'), F.MAX_GROSZE);
});

test('formatMoney: spacje tysięcy, przecinek i dwa miejsca, twarda spacja przed „zł”', () => {
  assert.equal(F.formatMoney(0), '0,00 zł');
  assert.equal(F.formatMoney(5), '0,05 zł');
  assert.equal(F.formatMoney(12000), '120,00 zł');
  assert.equal(F.formatMoney(123456), '1 234,56 zł');
  assert.equal(F.formatMoney(100000000), '1 000 000,00 zł');
  assert.equal(F.formatMoney(undefined), '0,00 zł');
});

test('parseMoney i formatMoney są odwracalne', () => {
  for (const g of [0, 1, 99, 100, 12050, 123456, 999999]) {
    assert.equal(F.parseMoney(F.formatMoney(g)), g);
  }
});

test('miesiące: klucze, etykiety, poprzedni miesiąc, ostatni dzień', () => {
  assert.equal(F.isMonthKey('2026-10'), true);
  assert.equal(F.isMonthKey('2026-13'), false);
  assert.equal(F.isMonthKey('2026-00'), false);
  assert.equal(F.isMonthKey('2026-1'), false);
  assert.equal(F.monthOf('2026-10-31'), '2026-10');
  assert.equal(F.monthLabel('2026-10'), 'październik 2026');
  assert.equal(F.monthLabel('2027-01'), 'styczeń 2027');
  assert.equal(F.prevMonth('2026-11'), '2026-10');
  assert.equal(F.prevMonth('2027-01'), '2026-12');
  assert.equal(F.lastDayOf('2026-10'), '2026-10-31');
  assert.equal(F.lastDayOf('2026-02'), '2026-02-28');
  assert.equal(F.lastDayOf('2028-02'), '2028-02-29');
  assert.equal(F.lastDayOf('2026-04'), '2026-04-30');
});

test('normalizeMonth: różne zapisy, puste pole, błędne dane', () => {
  assert.equal(F.normalizeMonth('2026-10'), '2026-10');
  assert.equal(F.normalizeMonth('2026-9'), '2026-09');
  assert.equal(F.normalizeMonth('10.2026'), '2026-10');
  assert.equal(F.normalizeMonth('9/2026'), '2026-09');
  assert.equal(F.normalizeMonth('  2026-10  '), '2026-10');
  assert.equal(F.normalizeMonth('', '2026-09'), '2026-09');
  assert.equal(F.normalizeMonth(undefined, '2026-09'), '2026-09');
  assert.equal(F.normalizeMonth('13.2026'), null);
  assert.equal(F.normalizeMonth('2026-13'), null);
  assert.equal(F.normalizeMonth('październik'), null);
  assert.equal(F.normalizeMonth('2026-10-05'), null);
});

test('firstWorkdayOf: pierwszy dzień roboczy miesiąca', () => {
  assert.equal(F.firstWorkdayOf('2026-11'), '2026-11-02'); // 1 XI 2026 to niedziela
  assert.equal(F.firstWorkdayOf('2026-08'), '2026-08-03'); // 1 VIII 2026 to sobota
  assert.equal(F.firstWorkdayOf('2026-10'), '2026-10-01'); // czwartek
  assert.equal(F.firstWorkdayOf('2027-01'), '2027-01-01'); // piątek
});

test('monthToPrepare: poprzedni miesiąc od pierwszego dnia roboczego, raz, nie przed włączeniem funkcji', () => {
  // niedziela 1 listopada: jeszcze za wcześnie
  assert.equal(F.monthToPrepare({ todayIso: '2026-11-01', start: '2026-10' }), null);
  // poniedziałek 2 listopada: pora na październik
  assert.equal(F.monthToPrepare({ todayIso: '2026-11-02', start: '2026-10' }), '2026-10');
  // kolejne dni: dalej październik, dopóki nie przygotowano
  assert.equal(F.monthToPrepare({ todayIso: '2026-11-20', start: '2026-10' }), '2026-10');
  // już przygotowany
  assert.equal(F.monthToPrepare({ todayIso: '2026-11-20', start: '2026-10', prepared: { '2026-10': { at: 'x' } } }), null);
  // funkcja włączona w listopadzie: października nie ruszamy
  assert.equal(F.monthToPrepare({ todayIso: '2026-11-02', start: '2026-11' }), null);
  // bez znacznika startu zachowuje się jak „od zawsze”
  assert.equal(F.monthToPrepare({ todayIso: '2026-11-02' }), '2026-10');
  // przełom roku
  assert.equal(F.monthToPrepare({ todayIso: '2027-01-04', start: '2026-12' }), '2026-12');
  // święta celowo pomijamy (bot nie zna kalendarza), więc w piątek 1 stycznia szkic też powstaje; i tak czeka na zatwierdzenie
  assert.equal(F.monthToPrepare({ todayIso: '2027-01-01', start: '2026-12' }), '2026-12');
});

test('bonusMonthFor: premia trafia do miesiąca tekstu, o ile ten jest jeszcze otwarty', () => {
  const base = { start: '2026-10', currentMonth: '2026-11' };
  // tekst z października, październik nie zatwierdzony: premia do października
  assert.equal(F.bonusMonthFor({ ...base, handedIn: '2026-10-20', closed: {} }), '2026-10');
  // październik już zatwierdzony: premia do bieżącego
  assert.equal(F.bonusMonthFor({ ...base, handedIn: '2026-10-20', closed: { '2026-10': true } }), '2026-11');
  // tekst z września, czyli sprzed funkcji: bieżący
  assert.equal(F.bonusMonthFor({ ...base, handedIn: '2026-09-30', closed: {} }), '2026-11');
  // tekst bez daty oddania: bieżący
  assert.equal(F.bonusMonthFor({ ...base, handedIn: null, closed: {} }), '2026-11');
  // tekst oddany w bieżącym miesiącu: bieżący
  assert.equal(F.bonusMonthFor({ ...base, handedIn: '2026-11-03', closed: {} }), '2026-11');
  // data z przyszłości (błąd w danych): bieżący
  assert.equal(F.bonusMonthFor({ ...base, handedIn: '2027-02-01', closed: {} }), '2026-11');
});

const T = (id, name, extra = {}) => ({
  id, name, url: `https://discord.com/channels/1/${id}`, status: 'Opublikowane', assigneeId: 'u1', handedIn: '2026-10-10', settled: null, archived: false, created: null, bonuses: [], ...extra,
});
const PEOPLE = { u1: { name: 'Zofia Kowalska', rate: 15000 }, u2: { name: 'Ada Nowak', rate: 8000 } };

test('buildReport: teksty z miesiąca, stawka osoby, sumy i kolejność', () => {
  const r = F.buildReport({
    month: '2026-10',
    people: PEOPLE,
    tasks: [
      T('1', 'Recenzja B', { handedIn: '2026-10-12' }),
      T('2', 'Recenzja A', { handedIn: '2026-10-03' }),
      T('3', 'Poradnik', { assigneeId: 'u2', handedIn: '2026-10-31', status: 'Do redakcji' }),
      T('4', 'Z września', { handedIn: '2026-09-30' }),
      T('5', 'Z listopada', { handedIn: '2026-11-01' }),
      T('6', 'W pisaniu', { status: 'W pisaniu', handedIn: '2026-10-05' }),
    ],
  });
  assert.equal(r.label, 'październik 2026');
  assert.deepEqual(r.persons.map((p) => p.name), ['Ada Nowak', 'Zofia Kowalska']); // alfabetycznie
  const zofia = r.persons[1];
  assert.deepEqual(zofia.texts.map((x) => x.title), ['Recenzja A', 'Recenzja B']); // po dacie oddania
  assert.equal(zofia.textsTotal, 30000);
  assert.equal(zofia.total, 30000);
  assert.equal(r.persons[0].total, 8000);
  assert.equal(r.grandTotal, 38000);
  assert.deepEqual(r.settle.texts.sort(), ['1', '2', '3']);
  assert.deepEqual(r.noRate, []);
  assert.deepEqual(r.unassigned, []);
});

test('buildReport: tekst, który nie został oddany do redakcji, nie liczy się nawet z datą', () => {
  for (const status of ['Pomysł', 'Przydzielone', 'W pisaniu']) {
    const r = F.buildReport({ month: '2026-10', people: PEOPLE, tasks: [T('1', 'x', { status })] });
    assert.equal(r.persons.length, 0, status);
  }
});

test('buildReport: premie wchodzą tylko w swoim miesiącu i nie liczą się dwa razy', () => {
  const tasks = [
    T('1', 'Z premią', { bonuses: [{ i: 'a1', a: 2000, n: 'post na Facebooku', m: '2026-10', s: null }, { i: 'a2', a: 500, n: 'Instagram', m: '2026-10', s: null }] }),
    T('2', 'Premia z listopada', { bonuses: [{ i: 'b1', a: 1000, n: 'Instagram', m: '2026-11', s: null }] }),
    T('3', 'Premia rozliczona', { bonuses: [{ i: 'c1', a: 5000, n: 'stara', m: '2026-10', s: '2026-10' }] }),
    T('4', 'Premia zerowa', { bonuses: [{ i: 'd1', a: 0, n: 'nic', m: '2026-10', s: null }] }),
  ];
  const r = F.buildReport({ month: '2026-10', people: PEOPLE, tasks });
  const z = r.persons[0];
  assert.equal(z.bonuses.length, 2);
  assert.deepEqual(z.bonuses.map((b) => [b.bid, b.amount, b.note]), [['a1', 2000, 'post na Facebooku'], ['a2', 500, 'Instagram']]);
  assert.equal(z.bonusTotal, 2500);
  assert.equal(z.textsTotal, 60000); // cztery teksty po 150 zł, premia nie zmienia liczby tekstów
  assert.equal(z.total, 62500);
  assert.deepEqual(r.settle.bonuses, [{ id: '1', bid: 'a1' }, { id: '1', bid: 'a2' }]);
});

test('buildReport: premia do tekstu, który już został rozliczony w poprzednim miesiącu, liczy się osobno', () => {
  const tasks = [T('1', 'Stary tekst', { handedIn: '2026-09-10', settled: '2026-09', bonuses: [{ i: 'x', a: 3000, n: 'TikTok', m: '2026-10', s: null }] })];
  const r = F.buildReport({ month: '2026-10', people: PEOPLE, tasks });
  const z = r.persons[0];
  assert.equal(z.texts.length, 0); // tekst rozliczony wcześniej
  assert.equal(z.bonuses.length, 1);
  assert.equal(z.total, 3000);
});

test('buildReport: tekst już rozliczony nie wchodzi drugi raz', () => {
  const r = F.buildReport({ month: '2026-10', people: PEOPLE, tasks: [T('1', 'x', { settled: '2026-10' })] });
  assert.equal(r.persons.length, 0);
  assert.deepEqual(r.settle.texts, []);
});

test('buildReport: osoba bez stawki trafia na osobną listę i nie dostaje protokołu', () => {
  const r = F.buildReport({
    month: '2026-10',
    people: { u1: { name: 'Zofia Kowalska', rate: 0 } },
    tasks: [T('1', 'a'), T('2', 'b', { assigneeId: 'u9' }), T('3', 'c', { assigneeId: 'u9', bonuses: [{ i: 'q', a: 100, n: '', m: '2026-10', s: null }] })],
  });
  assert.equal(r.persons.length, 0);
  assert.deepEqual(r.noRate.map((x) => [x.userId, x.texts, x.bonuses]).sort(), [['u1', 1, 0], ['u9', 2, 1]]);
  assert.deepEqual(r.settle.texts, []); // nic nie zostanie oznaczone jako rozliczone
});

test('buildReport: tekst bez osoby i bez daty oddania są zgłaszane, a nie gubione', () => {
  const r = F.buildReport({
    month: '2026-10',
    people: PEOPLE,
    tasks: [
      T('1', 'Bez osoby', { assigneeId: null }),
      T('2', 'Bez daty', { handedIn: null }),
      T('3', 'Bez daty, w archiwum', { handedIn: null, archived: true }),
      T('4', 'Bez daty, w pisaniu', { handedIn: null, status: 'W pisaniu' }),
      T('5', 'Premia bez osoby', { assigneeId: null, handedIn: '2026-09-01', settled: '2026-09', bonuses: [{ i: 'z', a: 100, n: '', m: '2026-10', s: null }] }),
    ],
  });
  assert.deepEqual(r.unassigned.map((x) => [x.id, x.kind]), [['1', 'tekst'], ['5', 'premia']]);
  assert.deepEqual(r.undated.map((x) => [x.id, x.archived]).sort(), [['2', false], ['3', true]]);
  assert.equal(r.persons.length, 0);
});

test('buildReport: teksty bez daty oddania pokazujemy tylko, gdy post założono w tym lub poprzednim miesiącu', () => {
  const r = F.buildReport({
    month: '2026-10',
    people: PEOPLE,
    tasks: [
      T('1', 'Z października', { handedIn: null, created: '2026-10-02' }),
      T('2', 'Z września', { handedIn: null, created: '2026-09-15' }),
      T('3', 'Z sierpnia', { handedIn: null, created: '2026-08-31' }),
      T('4', 'Bez daty założenia', { handedIn: null, created: null }),
    ],
  });
  assert.deepEqual(r.undated.map((x) => x.id), ['1', '2', '4']); // najnowsze założone na górze, bez daty na końcu
});

test('buildReport: zgłoszone premie za social trafiają na listę do zatwierdzenia, ale nie do protokołów ani odcisku', () => {
  const tasks = [
    T('1', 'Zgłoszony A', { claimed: true }),
    T('2', 'Zgłoszony B, już zatwierdzony', { claimed: true, socialDone: true }),
    T('3', 'Bez zgłoszenia'),
    T('4', 'Zgłoszony bez osoby', { claimed: true, assigneeId: null }),
    T('5', 'Zgłoszony, stary i opublikowany', { claimed: true, status: 'Opublikowane', handedIn: '2026-01-10' }),
  ];
  const r = F.buildReport({ month: '2026-10', people: PEOPLE, tasks });
  assert.deepEqual(r.claims.map((x) => x.id), ['1', '5'], 'tylko zgłoszenia z osobą i bez przyznanej premii, posortowane po tytule');
  assert.deepEqual(r.claims.map((x) => x.userId), [tasks[0].assigneeId, tasks[4].assigneeId]);
  const noClaims = F.buildReport({ month: '2026-10', people: PEOPLE, tasks: tasks.map((t) => ({ ...t, claimed: false })) });
  assert.equal(F.reportSignature(r), F.reportSignature(noClaims), 'zgłoszenia nie zmieniają protokołów, więc nie unieważniają szkicu');
  assert.deepEqual(noClaims.claims, []);
});

test('reportSignature: ten sam stan daje ten sam odcisk, każda zmiana w protokołach go zmienia', () => {
  const base = () => [T('1', 'a'), T('2', 'b', { assigneeId: 'u2' })];
  const sig = (tasks, people = PEOPLE) => F.reportSignature(F.buildReport({ month: '2026-10', people, tasks }));
  const ref = sig(base());
  assert.equal(sig(base()), ref);
  assert.notEqual(sig([...base(), T('3', 'c')]), ref); // nowy tekst
  assert.notEqual(sig(base(), { ...PEOPLE, u1: { ...PEOPLE.u1, rate: 15100 } }), ref); // zmiana stawki
  const bonus = base(); bonus[0].bonuses = [{ i: 'k', a: 100, n: '', m: '2026-10', s: null }];
  assert.notEqual(sig(bonus), ref); // sama premia do istniejącego tekstu
  const bonusNote = base(); bonusNote[0].bonuses = [{ i: 'k', a: 100, n: 'inny opis', m: '2026-10', s: null }];
  assert.notEqual(sig(bonusNote), sig(bonus)); // opis premii trafia do protokołu
  const moved = base(); moved[0].handedIn = '2026-10-11';
  assert.notEqual(sig(moved), ref); // zmiana daty oddania
  const other = base(); other[0].handedIn = '2026-09-11'; // wypada z miesiąca
  assert.notEqual(sig(other), ref);
  // rzeczy, które nie wchodzą do protokołu, odcisku nie zmieniają (np. archiwizacja posta)
  const arch = base(); arch[0].archived = true;
  assert.equal(sig(arch), ref);
});

test('buildReport: zestawienie nie zmienia danych wejściowych', () => {
  const tasks = [T('1', 'a', { bonuses: [{ i: 'k', a: 100, n: 'x', m: '2026-10', s: null }] })];
  const copy = JSON.stringify(tasks);
  F.buildReport({ month: '2026-10', people: PEOPLE, tasks });
  assert.equal(JSON.stringify(tasks), copy);
});

test('buildReport: stawka z chwili zestawienia trafia do każdej linii', () => {
  const r = F.buildReport({ month: '2026-10', people: PEOPLE, tasks: [T('1', 'a'), T('2', 'b')] });
  assert.deepEqual(r.persons[0].texts.map((x) => [x.rate, x.amount]), [[15000, 15000], [15000, 15000]]);
});

test('safeFileName: bez polskich znaków, spacji i dziwnych znaków', () => {
  assert.equal(F.safeFileName('Zofia Kowalska'), 'zofia-kowalska');
  assert.equal(F.safeFileName('Żaneta Łącka-Ćwik'), 'zaneta-lacka-cwik');
  assert.equal(F.safeFileName('  ../../etc/passwd  '), 'etc-passwd');
  assert.equal(F.safeFileName('★★★'), 'osoba');
  assert.equal(F.safeFileName(''), 'osoba');
});
