'use strict';
// Autor: Mateusz Bartoszewicz
// Rozliczenia z osobami piszącymi: kwoty w groszach, miesiące i zestawienie tekstów do protokołu.
// Czysta logika, bez Discorda i dysku, żeby dało się ją sprawdzić testami jednostkowymi.
const { isWritingDone } = require('./board');

// Godziny w protokole: stałe 2 godziny za każdy rozliczony tekst (premie nie dodają godzin). Więcej za tekst wpisać nie wolno,
// więc protokół podaje liczbę sam, zamiast prosić osobę o dopisanie.
const HOURS_PER_TEXT = 2;
const MAX_GROSZE = 10_000_000; // 100 000,00 zł: górna granica rozsądku, żeby literówka nie zrobiła z 120 zł milionów

// ---------------------------------------------------------------- kwoty
// Przyjmuje „120”, „120,5”, „120,50”, „120.50”, „1 200,50” i „120 zł”. Zwraca grosze albo null.
function parseMoney(input) {
  const s = String(input ?? '').replace(/[\s\u00a0]/g, '').toLowerCase().replace(/(zł|zl|pln)$/, '');
  if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const [zl, gr = ''] = s.split(/[.,]/);
  const grosze = parseInt(zl, 10) * 100 + parseInt(gr.padEnd(2, '0'), 10);
  return Number.isSafeInteger(grosze) && grosze <= MAX_GROSZE ? grosze : null;
}

// 123456 -> „1 234,56 zł” (spacje twarde, żeby kwota nie łamała się w połowie).
function formatMoney(grosze) {
  const g = Math.round(Number(grosze) || 0);
  const zl = String(Math.floor(g / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${zl},${String(g % 100).padStart(2, '0')}\u00a0zł`;
}

// 2 -> „2 godziny”, 5 -> „5 godzin”, 1 -> „1 godzina”.
function formatHours(n) {
  const a = n % 100;
  const b = n % 10;
  const word = n === 1 ? 'godzina' : (b >= 2 && b <= 4 && !(a >= 12 && a <= 14) ? 'godziny' : 'godzin');
  return `${n} ${word}`;
}

// ---------------------------------------------------------------- miesiące
const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const isMonthKey = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
const monthOf = (iso) => String(iso).slice(0, 7);
const monthLabel = (key) => `${MONTHS[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;

function prevMonth(key) {
  let y = +key.slice(0, 4);
  let m = +key.slice(5, 7) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function nextMonth(key) {
  let y = +key.slice(0, 4);
  let m = +key.slice(5, 7) + 1;
  if (m === 13) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function lastDayOf(key) {
  const y = +key.slice(0, 4);
  const m = +key.slice(5, 7);
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// Pierwszy dzień roboczy (pon.-pt.) miesiąca jako data ISO. Święta pomijamy: bot nie zna kalendarza, a szkic i tak czeka na zatwierdzenie.
function firstWorkdayOf(key) {
  for (let d = 1; d <= 3; d += 1) {
    const wd = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, d)).getUTCDay();
    if (wd >= 1 && wd <= 5) return `${key}-${String(d).padStart(2, '0')}`;
  }
  return `${key}-01`;
}

// „2026-10”, „10.2026” albo „10/2026” -> „2026-10”; puste pole -> domyślny miesiąc; reszta -> null.
function normalizeMonth(input, fallback = null) {
  const s = String(input ?? '').trim();
  if (!s) return fallback;
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return isMonthKey(`${m[1]}-${m[2].padStart(2, '0')}`) ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
  m = /^(\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return isMonthKey(`${m[2]}-${m[1].padStart(2, '0')}`) ? `${m[2]}-${m[1].padStart(2, '0')}` : null;
  return null;
}

// Który miesiąc przygotować dziś? Poprzedni, od pierwszego dnia roboczego bieżącego, o ile jeszcze go nie przygotowano
// i nie jest starszy niż dzień włączenia rozliczeń (`start`), żeby bot nie robił protokołów za czas sprzed funkcji.
function monthToPrepare({ todayIso, start = null, prepared = {} }) {
  const cur = monthOf(todayIso);
  if (todayIso < firstWorkdayOf(cur)) return null;
  const prev = prevMonth(cur);
  if (start && prev < start) return null;
  if (prepared[prev]) return null;
  return prev;
}

// W którym miesiącu rozliczyć premię dodaną dziś do tekstu oddanego w `handedIn`? W miesiącu tekstu, jeśli ten jest jeszcze otwarty
// (nie zatwierdzono jego protokołu, nie jest starszy niż rozliczenia i nie jest przyszłością), a w przeciwnym razie w bieżącym.
function bonusMonthFor({ handedIn, start, closed = {}, currentMonth }) {
  const tm = handedIn ? monthOf(handedIn) : null;
  if (tm && (!start || tm >= start) && tm <= currentMonth && !closed[tm]) return tm;
  return currentMonth;
}

// Za który miesiąc rozliczyć oddany tekst, gdy zestawiamy miesiąc `month`?
// Zasada: miesiąc WPISANEGO TERMINU ODDANIA (`due`), a bez terminu miesiąc faktycznego przekazania do redakcji (`handedIn`).
// Wyjątek: miesiąc terminu jest już zamknięty (protokół wysłany albo pominięty, albo sprzed włączenia rozliczeń), a tekst przekazano
// dopiero w późniejszym miesiącu (spóźnienie). Wtedy tekst wchodzi do miesiąca przekazania (albo pierwszego otwartego po nim), żeby nie przepadł.
// Zestawiany miesiąc nigdy nie liczy się jako zamknięty: protokół uzupełniający dalej widzi swoje teksty.
// null = brak terminu i daty przekazania (tekst trafia do menu „bez daty”).
function textMonthFor({ due = null, handedIn = null, start = null, closed = {}, month }) {
  const isClosed = (m) => m !== month && (Boolean(closed[m]) || Boolean(start && m < start));
  const base = due ? monthOf(due) : handedIn ? monthOf(handedIn) : null;
  if (!base || !isClosed(base)) return base;
  const handedMonth = handedIn ? monthOf(handedIn) : null;
  if (!handedMonth || handedMonth <= base) return base; // nie spóźniony: zostaje w swoim miesiącu (protokół uzupełniający)
  let m = handedMonth;
  while (isClosed(m)) m = nextMonth(m);
  return m;
}

// ---------------------------------------------------------------- zestawienie
// tasks: {id, name, url, status, assigneeId, due, handedIn, settled, archived, created, bonuses: [{i, a, n, m, s}], claimed, socialDone}
//   due: wpisany termin oddania (YYYY-MM-DD), handedIn: faktyczne przekazanie do redakcji, settled: miesiąc rozliczenia tekstu, created: data założenia posta,
//   bonuses: premie (i = numer premii, a = kwota w groszach, n = za co, m = miesiąc rozliczenia, s = miesiąc, w którym już rozliczono),
//   claimed: osoba zgłosiła premię za social, a zarząd jeszcze jej nie zatwierdził, socialDone: premia za social jest już przyznana
// people: {userId: {name, rate}}  (rate w groszach); start: pierwszy miesiąc rozliczeń; closed: {miesiąc: true} dla wysłanych lub pominiętych
function buildReport({ month, tasks, people = {}, start = null, closed = {} }) {
  const byPerson = new Map();
  const noRate = new Map();
  const unassigned = [];
  const undated = [];
  const claims = []; // zgłoszone premie za social do zatwierdzenia przez zarząd (nie wchodzą do protokołów, dopóki ich nie zatwierdzi)
  const person = (id) => {
    if (!byPerson.has(id)) byPerson.set(id, { userId: id, texts: [], bonuses: [] });
    return byPerson.get(id);
  };
  // Teksty bez daty oddania pokazujemy tylko wtedy, gdy mogły zostać oddane w tym miesiącu: starsze post-y założono przed poprzednim miesiącem.
  const oldestCreated = `${prevMonth(month)}-01`;

  for (const t of tasks) {
    if (t.claimed && !t.socialDone && t.assigneeId) claims.push({ id: t.id, title: t.name, userId: t.assigneeId });
    const handed = isWritingDone(t.status) && !t.settled;
    const tm = handed ? textMonthFor({ due: t.due || null, handedIn: t.handedIn || null, start, closed, month }) : null;
    if (handed && !tm && t.assigneeId && (!t.created || t.created >= oldestCreated)) {
      undated.push({ id: t.id, title: t.name, archived: Boolean(t.archived), status: t.status, assigneeId: t.assigneeId, created: t.created || null });
    }
    if (handed && tm === month) {
      if (!t.assigneeId) unassigned.push({ id: t.id, title: t.name, kind: 'tekst' });
      // date: termin oddania (podstawa rozliczenia), handedIn: kiedy tekst faktycznie przekazano (w PDF obok terminu)
      else person(t.assigneeId).texts.push({ id: t.id, title: t.name, url: t.url, date: t.due || t.handedIn, handedIn: t.handedIn || null });
    }
    // Premie nierozliczonego, oddanego tekstu idą RAZEM Z TEKSTEM, do miesiąca, w którym tekst się rozlicza (zapisany przy premii miesiąc
    // mógł się zdezaktualizować: termin poprawiony później, tekst przeniesiony z opóźnieniem). Zapisany miesiąc premii (b.m) liczy się dopiero,
    // gdy tekst jest już rozliczony (premia dodana po protokole) albo jego miesiąca nie da się ustalić.
    const follow = handed && tm ? tm : null;
    for (const b of t.bonuses || []) {
      if (!(b.a > 0) || b.s || (follow || b.m) !== month) continue;
      if (!t.assigneeId) unassigned.push({ id: t.id, title: t.name, kind: 'premia' });
      else person(t.assigneeId).bonuses.push({ id: t.id, bid: b.i, title: t.name, note: b.n || '', amount: b.a });
    }
  }

  const persons = [];
  const settle = { texts: [], bonuses: [] };
  for (const p of byPerson.values()) {
    const info = people[p.userId];
    if (!info || !info.name || !(info.rate > 0)) {
      noRate.set(p.userId, { userId: p.userId, texts: p.texts.length, bonuses: p.bonuses.length });
      continue;
    }
    p.texts.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'pl') || a.id.localeCompare(b.id));
    p.bonuses.sort((a, b) => a.title.localeCompare(b.title, 'pl') || String(a.bid).localeCompare(String(b.bid)));
    const lines = p.texts.map((x) => ({ ...x, rate: info.rate, amount: info.rate }));
    const textsTotal = lines.reduce((s, x) => s + x.amount, 0);
    const bonusTotal = p.bonuses.reduce((s, x) => s + x.amount, 0);
    persons.push({
      userId: p.userId, name: info.name, rate: info.rate, texts: lines, bonuses: p.bonuses, textsTotal, bonusTotal, total: textsTotal + bonusTotal,
      hours: lines.length * HOURS_PER_TEXT,
    });
    for (const x of lines) settle.texts.push(x.id);
    for (const x of p.bonuses) settle.bonuses.push({ id: x.id, bid: x.bid });
  }
  persons.sort((a, b) => a.name.localeCompare(b.name, 'pl') || a.userId.localeCompare(b.userId));
  undated.sort((a, b) => (b.created || '').localeCompare(a.created || '') || a.title.localeCompare(b.title, 'pl')); // najnowsze na górze, bez daty na końcu
  claims.sort((a, b) => a.title.localeCompare(b.title, 'pl') || a.id.localeCompare(b.id));
  return {
    month,
    label: monthLabel(month),
    persons,
    noRate: [...noRate.values()],
    unassigned,
    undated,
    claims,
    settle,
    grandTotal: persons.reduce((s, p) => s + p.total, 0),
  };
}

// Odcisk tego, co trafi do protokołów (osoby, stawki, teksty, premie). Dwa zestawienia z tym samym odciskiem dają identyczne protokoły,
// więc zatwierdzenie szkicu można porównać z aktualnym stanem zadań.
function reportSignature(report) {
  return JSON.stringify(report.persons.map((p) => [
    p.userId, p.name, p.rate,
    p.texts.map((x) => [x.id, x.title, x.date, x.handedIn || null, x.amount]),
    p.bonuses.map((x) => [x.id, x.bid, x.note, x.amount]),
  ]));
}

// Nazwa pliku bez polskich znaków i spacji (Discord i poczta różnie je traktują).
function safeFileName(text) {
  const map = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
  return String(text).toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => map[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'osoba';
}

module.exports = {
  parseMoney, formatMoney, MAX_GROSZE, HOURS_PER_TEXT, formatHours,
  isMonthKey, monthOf, monthLabel, prevMonth, nextMonth, lastDayOf, firstWorkdayOf, normalizeMonth, monthToPrepare, bonusMonthFor, textMonthFor,
  buildReport, reportSignature, safeFileName,
};
