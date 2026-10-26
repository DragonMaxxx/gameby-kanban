// Autor: Mateusz Bartoszewicz
// Daty, inicjały i kolory zastępcze awatarów.
const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

const dayNumber = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
};

export function shortDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : '';
}

// Termin na karcie: kolor zależy od tego, ile zostało (liczone od dnia podanego przez serwer, czyli w strefie redakcji).
export function dueInfo(due, today) {
  const d = dayNumber(due);
  const t = dayNumber(today);
  if (d === null) return null;
  if (t === null) return { text: shortDate(due), tone: 'ok' };
  const left = d - t;
  if (left < 0) return { text: `${shortDate(due)} · po terminie`, tone: 'overdue' };
  if (left === 0) return { text: 'dziś', tone: 'soon' };
  if (left === 1) return { text: 'jutro', tone: 'soon' };
  return { text: shortDate(due), tone: left <= 3 ? 'soon' : 'ok' };
}

// Plakietki terminów na karcie. Liczy się jeden termin naraz (jak na Discordzie): podczas pisania wcześniejszy z dwóch,
// po oddaniu tekstu tylko publikacja, a dla opublikowanych żaden. Drugi termin jest tylko informacją, bez odliczania.
// handedIn: tekst oddany (Do redakcji, Do publikacji, Opublikowane), czyli status z listy writingDone z serwera.
export function dueChips(task, today, handedIn) {
  if (task.status === 'Opublikowane') return [];
  const write = task.due || null;
  const pub = task.pubDue || null;
  const wi = write ? dueInfo(write, today) : null;
  const pi = pub ? dueInfo(pub, today) : null;
  const pubChip = (i) => ({ text: `publikacja ${i.text}`, tone: i.tone, label: `Publikacja: ${i.text}` });
  if (handedIn) {
    if (pi) return [pubChip(pi)];
    return wi ? [{ text: 'tekst oddany', tone: 'done', label: 'Tekst oddany' }] : [];
  }
  const writeChip = (i) => ({ text: i.text, tone: i.tone, label: `Termin: ${i.text}` });
  const note = (kind, iso) => ({ text: `${kind} ${shortDate(iso)}`, tone: 'ok', label: `${kind === 'oddanie' ? 'Oddanie' : 'Publikacja'}: ${shortDate(iso)}` });
  if (wi && pi) return write <= pub ? [writeChip(wi), note('publikacja', pub)] : [pubChip(pi), note('oddanie', write)];
  if (wi) return [writeChip(wi)];
  if (pi) return [pubChip(pi)];
  return [];
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

// Stały kolor z numeru osoby, żeby ten sam brak zdjęcia wyglądał tak samo wszędzie.
export function hueOf(id) {
  let n = 0;
  for (const ch of String(id)) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

// Adres wpisu na Discordzie: bierzemy tylko https://discord.com/channels/..., żadnych innych schematów z danych serwera.
export function safeDiscordUrl(url) {
  return typeof url === 'string' && /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/channels\/\d+\/\d+(?:\/\d+)?$/.test(url) ? url : null;
}

// Premia za social: stan widać dla wszystkich (plakietka, opis w oknie zadania), kwoty nigdy. Kwoty i zatwierdzanie obsługuje bot.
export const SOCIAL = {
  claimed: { text: 'social: zgłoszone', tone: 'soon', label: 'Premia za social zgłoszona, czeka na zatwierdzenie', status: 'zgłoszone, czeka na zatwierdzenie przez zarząd' },
  ok: { text: 'social ✓', tone: 'done', label: 'Premia za social zatwierdzona', status: 'zatwierdzone' },
  settled: { text: 'social ✓', tone: 'done', label: 'Premia za social rozliczona', status: 'rozliczone w protokole' },
};
