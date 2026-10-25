'use strict';
// Autor: Mateusz Bartoszewicz
// Czysta logika kanbana (bez Discorda): statusy z tagów forum, uprawnienia ruchów,
// daty, renderowanie tablicy i podsumowania. Całość da się testować bez sieci.

const STATUSES = ['Pomysł', 'Przydzielone', 'W pisaniu', 'Do redakcji', 'Do publikacji', 'Opublikowane'];
// Te statusy ustawia tylko osoba z uprawnieniem "Zarządzanie wątkami" (kierownictwo, moderacja),
// tak samo jak moderowane tagi na forum.
const RESTRICTED = new Set(['Do publikacji', 'Opublikowane']);
// Termin dotyczy oddania tekstu. Od chwili, gdy tekst trafił do redakcji, autor ma swoje za sobą, więc te statusy
// nie są "po terminie" (czekanie na redakcję i na publikację ma własne sekcje w podsumowaniu dnia).
const WRITING_DONE = new Set(['Do redakcji', 'Do publikacji', 'Opublikowane']);
const isWritingDone = (status) => WRITING_DONE.has(status);
const COLOR = 0x1EB53A;
const MAX_FIELD_CHARS = 850; // 6 pól po <= 850 znaków mieści się w limicie 6000 znaków całego embeda
const PUBLISHED_SHOWN = 3;
const COLUMN_PUBLISHED_SHOWN = 5;
const MAX_COLUMN_CHARS = 3800; // opis embeda może mieć 4096 znaków
const STATUS_COLORS = {
  'Pomysł': 0x95A5A6, Przydzielone: 0x3498DB, 'W pisaniu': 0xF1C40F,
  'Do redakcji': 0x9B59B6, 'Do publikacji': 0x1ABC9C, Opublikowane: 0x2ECC71,
};

const norm = (s) => String(s).trim().toLocaleLowerCase('pl');

// ---------------------------------------------------------------- tagi i statusy
// availableTags: [{id, name}] z kanału forum.
function statusTags(availableTags) {
  const byName = new Map();
  const byId = new Map();
  const missing = [];
  for (const status of STATUSES) {
    const tag = (availableTags || []).find((t) => norm(t.name) === norm(status));
    if (tag) { byName.set(status, tag); byId.set(tag.id, status); } else { missing.push(status); }
  }
  return { byName, byId, missing };
}

// Gdy post ma kilka tagów statusu, liczy się najdalszy etap.
function currentStatus(appliedTags, st) {
  let best = null;
  for (const id of appliedTags || []) {
    const status = st.byId.get(id);
    if (status && (best === null || STATUSES.indexOf(status) > STATUSES.indexOf(best))) best = status;
  }
  return best;
}

// Tagi tematów (wszystkie, które nie są statusami).
function topicTags(appliedTags, st) {
  return (appliedTags || []).filter((id) => !st.byId.has(id));
}

// Zamienia tag statusu i zostawia tagi tematów. Discord pozwala na maksymalnie 5 tagów, więc przy
// 5 tagach tematu nie ma miejsca na status: nie usuwamy po cichu żadnego tagu, tylko zgłaszamy błąd.
function withStatus(appliedTags, st, target) {
  const tag = st.byName.get(target);
  if (!tag) throw new Error(`Brak tagu statusu: ${target}`);
  const others = topicTags(appliedTags, st);
  if (others.length >= 5) throw new RangeError('TOO_MANY_TOPIC_TAGS');
  return [...others, tag.id];
}

function stepStatus(current, direction) {
  const i = STATUSES.indexOf(current);
  if (i < 0) return null;
  const j = i + direction;
  return j >= 0 && j < STATUSES.length ? STATUSES[j] : null;
}

function canMove(from, to, mayManageThreads) {
  if (mayManageThreads) return true;
  return !(RESTRICTED.has(from) || RESTRICTED.has(to));
}

// ---------------------------------------------------------------- daty
function isoValid(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const pad = (n) => String(n).padStart(2, '0');

// Przyjmuje 2026-11-05, 05.11.2026 oraz 05.11 (bez roku). Zwraca ISO albo null.
// Bez roku: domyślnie najbliższa taka data od dziś w przyszłości (komenda /zadanie).
// Z opcją nearest: rok dający datę najbliższą dzisiejszej, także z przeszłości (ręcznie wpisane terminy w postach).
function normalizeDate(input, todayIso, { nearest = false } = {}) {
  const s = String(input ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isoValid(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` : null;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return isoValid(+m[3], +m[2], +m[1]) ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null;
  m = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(s);
  if (m && todayIso) {
    const year = +todayIso.slice(0, 4);
    const at = (y) => (isoValid(y, +m[2], +m[1]) ? `${y}-${pad(+m[2])}-${pad(+m[1])}` : null);
    if (nearest) {
      const options = [year - 1, year, year + 1].map(at).filter(Boolean);
      if (!options.length) return null;
      return options.reduce((best, iso) => (Math.abs(daysBetween(todayIso, iso)) < Math.abs(daysBetween(todayIso, best)) ? iso : best));
    }
    const thisYear = at(year);
    if (thisYear && thisYear >= todayIso) return thisYear;
    return at(year + 1) ?? (thisYear && thisYear >= todayIso ? thisYear : null);
  }
  return null;
}

function daysBetween(fromIso, toIso) {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

const fmtDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

function todayIn(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function clockIn(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return { hour: parseInt(get('hour'), 10) % 24, weekday: wd };
}

// Podsumowanie wychodzi raz dziennie: od pełnej godziny `hour` przez `windowHours` godzin
// (żeby bot uruchomiony późnym wieczorem nie wysyłał porannego podsumowania).
function shouldSendDigest({ now, timeZone, hour, weekdays, lastSentIso, windowHours = 6 }) {
  const today = todayIn(timeZone, now);
  if (lastSentIso === today) return false;
  const { hour: h, weekday } = clockIn(timeZone, now);
  if (!weekdays.includes(weekday)) return false;
  return h >= hour && h < hour + windowHours;
}

// ---------------------------------------------------------------- treść posta
// Czytamy dwie linie z pierwszej wiadomości posta (etykieta może być pogrubiona):
//   Odpowiedzialny: <@123>
//   Termin: 05.11.2026   (albo 2026-11-05, albo 05.11 - wtedy rok najbliższy dzisiejszej dacie)
function parseMeta(content, todayIso) {
  const text = String(content ?? '');
  const a = /Odpowiedzialn(?:y|a)[\s*_]*:[\s*_]*<@!?(\d+)>/i.exec(text);
  const d = /Termin[\s*_]*:[\s*_]*([0-9.\-]{4,10})/i.exec(text);
  return { assigneeId: a ? a[1] : null, due: d ? normalizeDate(d[1], todayIso, { nearest: true }) : null };
}

// Treść pierwszej wiadomości zadania dodanego przez bota. Osoba i termin żyją na karcie i w pamięci bota.
function buildStarterContent({ description, authorId }) {
  return (description || `Zadanie dodane przez <@${authorId}>.`).slice(0, 2000);
}

// ---------------------------------------------------------------- renderowanie
function esc(text) {
  return Array.from(String(text).replace(/\s+/g, ' ').trim()).slice(0, 60).join('').replace(/([\\*_`~|\[\]()<>])/g, '\\$1');
}

function whenLabel(due, today) {
  const n = daysBetween(today, due);
  if (n < 0) return `po terminie o ${-n} ${-n === 1 ? 'dzień' : 'dni'}`;
  if (n === 0) return 'dziś';
  if (n === 1) return 'jutro';
  return `za ${n} dni`;
}

// Kolorowy znacznik terminu: po terminie, dziś lub jutro, do 3 dni, później, bez terminu.
function dueDot(due, today) {
  if (!due) return '⚪';
  const n = daysBetween(today, due);
  if (n < 0) return '🔴';
  if (n <= 1) return '🟠';
  if (n <= 3) return '🟡';
  return '🟢';
}

function taskLine(task, today, { showStatus = false } = {}) {
  const done = task.status === 'Opublikowane'; // opublikowane nie są "po terminie"
  const handedIn = isWritingDone(task.status) && !done; // tekst oddany, czeka na redakcję lub publikację
  const mark = done ? '✅' : handedIn ? '📝' : dueDot(task.due, today);
  let line = `${mark} ${task.urgent && !done ? '🔥 ' : ''}[${esc(task.name)}](${task.url})`;
  if (showStatus) line += ` (${task.status})`;
  const who = task.assigneeId ? ` <@${task.assigneeId}>` : (done ? '' : ' · bez osoby');
  let due = '';
  if (handedIn) due = ' · tekst oddany';
  else if (task.due && !done) due = ` · ${fmtDate(task.due).slice(0, 5)}, ${whenLabel(task.due, today)}`;
  return `${line}${who}${due}`;
}

// Numery Discorda (snowflake) rosną z czasem; porównujemy je jako liczby zapisane tekstem.
function compareIds(a, b) {
  return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;
}

// Pilne najpierw, potem najbliższy termin, potem kolejność zakładania.
function compareTasks(a, b) {
  if (Boolean(a.urgent) !== Boolean(b.urgent)) return a.urgent ? -1 : 1;
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return compareIds(a.id, b.id);
}

// Opublikowane: najnowszy post na górze (termin i priorytet już się nie liczą).
const newestFirst = (a, b) => compareIds(b.id, a.id);

function linesWithin(list, today, { limit = Infinity, showStatus = false, maxChars = MAX_FIELD_CHARS } = {}) {
  const lines = [];
  let used = 0;
  for (const t of list) {
    const line = taskLine(t, today, { showStatus });
    if (lines.length >= limit || used + line.length + 1 > maxChars - 24) {
      lines.push(`… i ${list.length - lines.length} więcej`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

function fieldFor(name, list, today, opts = {}) {
  const lines = linesWithin(list, today, opts);
  return { name: `${name} (${list.length})`.slice(0, 256), value: lines.join('\n') || '—', inline: false };
}

// tasks: [{id, name, url, status, assigneeId, due}]
function renderBoard(tasks, today, { onlyUserId = null, note = '' } = {}) {
  const list = onlyUserId ? tasks.filter((t) => t.assigneeId === onlyUserId) : tasks;
  const fields = [];
  for (const status of STATUSES) {
    const col = list.filter((t) => t.status === status);
    if (status === 'Opublikowane') {
      col.sort(newestFirst);
      if (col.length || !onlyUserId) fields.push(fieldFor(status, col, today, { limit: PUBLISHED_SHOWN }));
    } else {
      col.sort(compareTasks);
      if (col.length || !onlyUserId) fields.push(fieldFor(status, col, today));
    }
  }
  return {
    title: onlyUserId ? 'Tablica: moje zadania' : 'Tablica redakcji',
    color: COLOR,
    description: list.length ? undefined : 'Brak zadań.',
    fields,
    footer: { text: `Status zmienisz w menu w poście, a nowe zadanie dodasz komendą /zadanie.${note ? ` ${note}` : ''}` },
  };
}

// ---------------------------------------------------------------- żywa tablica i filtry
function isOpen(t) { return t.status !== 'Opublikowane'; }

// Jedna kolumna jako osobny embed (żywa tablica ma po jednej wiadomości na kolumnę).
function renderColumn(status, tasks, today) {
  const col = tasks.filter((t) => t.status === status);
  let lines;
  if (status === 'Opublikowane') {
    col.sort(newestFirst);
    lines = linesWithin(col, today, { limit: COLUMN_PUBLISHED_SHOWN, maxChars: MAX_COLUMN_CHARS });
  } else {
    col.sort(compareTasks);
    lines = linesWithin(col, today, { maxChars: MAX_COLUMN_CHARS });
  }
  return { title: `${status} · ${col.length}`, color: STATUS_COLORS[status], description: lines.join('\n') || '—' };
}

function summaryCounts(tasks, today) {
  const open = tasks.filter(isOpen);
  const writing = open.filter((t) => !isWritingDone(t.status)); // terminy liczą się tylko do oddania tekstu
  return {
    open: open.length,
    overdue: writing.filter((t) => t.due && daysBetween(today, t.due) < 0).length,
    soon: writing.filter((t) => t.due && daysBetween(today, t.due) >= 0 && daysBetween(today, t.due) <= 3).length,
    unassigned: open.filter((t) => !t.assigneeId).length,
    urgent: open.filter((t) => t.urgent).length,
  };
}

function renderHeader(tasks, today, { note = '' } = {}) {
  const c = summaryCounts(tasks, today);
  return {
    title: 'Tablica redakcji',
    color: COLOR,
    description: [
      `**Otwarte:** ${c.open} · **Po terminie:** ${c.overdue} · **Termin w 3 dni:** ${c.soon} · **Bez osoby:** ${c.unassigned} · **Pilne:** ${c.urgent}`,
      '🔴 po terminie · 🟠 dziś lub jutro · 🟡 do 3 dni · 🟢 później · ⚪ bez terminu · 📝 tekst oddany · ✅ opublikowane · 🔥 pilne',
      note,
    ].filter(Boolean).join('\n'),
    footer: { text: 'Tablica odświeża się sama. Zadanie dodasz przyciskiem poniżej, a status zmienisz w poście.' },
  };
}

const FILTERS = {
  moje: 'Moje zadania',
  'bez-osoby': 'Bez osoby',
  'po-terminie': 'Po terminie',
  pilne: 'Pilne',
  wszystkie: 'Wszystkie otwarte',
};

function filterTasks(tasks, kind, userId, today) {
  const open = tasks.filter(isOpen);
  switch (kind) {
    case 'moje': return open.filter((t) => t.assigneeId === userId);
    case 'bez-osoby': return open.filter((t) => !t.assigneeId);
    case 'po-terminie': return open.filter((t) => !isWritingDone(t.status) && t.due && daysBetween(today, t.due) < 0);
    case 'pilne': return open.filter((t) => t.urgent);
    default: return open;
  }
}

function renderList(title, list, today, { note = '' } = {}) {
  const sorted = [...list].sort(compareTasks);
  const lines = linesWithin(sorted, today, { showStatus: true, maxChars: MAX_COLUMN_CHARS });
  return {
    title: `${title} · ${list.length}`,
    color: COLOR,
    description: lines.join('\n') || 'Nic tu nie ma.',
    ...(note ? { footer: { text: note } } : {}),
  };
}

function digestSections(tasks, today, soonDays = 3) {
  const open = tasks.filter((t) => t.status !== 'Opublikowane');
  const dated = open.filter((t) => t.due && !isWritingDone(t.status)); // oddane teksty mają własne sekcje niżej
  const overdue = dated.filter((t) => daysBetween(today, t.due) < 0).sort(compareTasks);
  const soon = dated.filter((t) => { const n = daysBetween(today, t.due); return n >= 0 && n <= soonDays; }).sort(compareTasks);
  const review = tasks.filter((t) => t.status === 'Do redakcji').sort(compareTasks);
  const ready = tasks.filter((t) => t.status === 'Do publikacji').sort(compareTasks);
  // Zadania w redakcji i do publikacji mają własne sekcje, więc tu ich nie powtarzamy.
  const unassigned = open.filter((t) => !t.assigneeId && t.status !== 'Do redakcji' && t.status !== 'Do publikacji').sort(compareTasks);
  return { overdue, soon, review, ready, unassigned };
}

// Zwraca {embed, pingIds} albo null, gdy nie ma nic do pokazania.
function renderDigest(tasks, today, { soonDays = 3, note = '' } = {}) {
  const s = digestSections(tasks, today, soonDays);
  const fields = [];
  if (s.overdue.length) fields.push(fieldFor('Po terminie', s.overdue, today, { showStatus: true }));
  if (s.soon.length) fields.push(fieldFor(`Termin w ciągu ${soonDays} dni`, s.soon, today, { showStatus: true }));
  if (s.review.length) fields.push(fieldFor('Czeka na redakcję', s.review, today));
  if (s.ready.length) fields.push(fieldFor('Gotowe do publikacji', s.ready, today));
  if (s.unassigned.length) fields.push(fieldFor('Bez osoby, do wzięcia', s.unassigned, today, { limit: 8, showStatus: true }));
  if (!fields.length) return null;
  const pingIds = [...new Set([...s.overdue, ...s.soon].map((t) => t.assigneeId).filter(Boolean))];
  return {
    embed: { title: 'Podsumowanie dnia', color: COLOR, fields, footer: { text: `Pełna tablica: /tablica${note ? `. ${note}` : ''}` } },
    pingIds,
  };
}

module.exports = {
  STATUSES, RESTRICTED, WRITING_DONE, isWritingDone, COLOR, STATUS_COLORS, FILTERS, MAX_FIELD_CHARS,
  norm, statusTags, currentStatus, topicTags, withStatus, stepStatus, canMove,
  normalizeDate, daysBetween, fmtDate, todayIn, clockIn, shouldSendDigest,
  parseMeta, buildStarterContent, esc, whenLabel, dueDot, taskLine, compareTasks, compareIds, newestFirst,
  renderBoard, renderDigest, digestSections, renderColumn, renderHeader, renderList, summaryCounts, filterTasks, isOpen,
};
