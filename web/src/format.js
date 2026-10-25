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
