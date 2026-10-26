'use strict';
// Autor: Mateusz Bartoszewicz
// Konfiguracja wyłącznie ze zmiennych środowiskowych (plik .env przekazuje Docker).

// Błąd w ustawieniach (.env): nie ma sensu ponawiać połączenia z Discordem.
class ConfigError extends Error {}

function bool(value, def) {
  if (value === undefined || value === '') return def;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new ConfigError(`Nieprawidłowa wartość logiczna: ${value} (użyj 0 albo 1)`);
}

function loadConfig(rawEnv = process.env) {
  // Plik .env z Windowsa bywa zapisany z końcami linii CRLF: obcinamy białe znaki w każdej wartości.
  const env = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const need = (name) => {
    const v = (env[name] || '').trim();
    if (!v) throw new ConfigError(`Brak zmiennej ${name} (ustaw ją w pliku .env).`);
    return v;
  };
  const token = need('DISCORD_TOKEN');
  const guildId = need('GUILD_ID');
  if (!/^\d{15,25}$/.test(guildId)) throw new ConfigError('GUILD_ID to numer serwera (same cyfry).');

  const hour = parseInt(env.DIGEST_HOUR ?? '9', 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new ConfigError('DIGEST_HOUR: liczba od 0 do 23.');
  const weekdays = String(env.DIGEST_WEEKDAYS ?? '1,2,3,4,5').split(',').map((s) => parseInt(s.trim(), 10));
  if (!weekdays.length || weekdays.some((d) => !(d >= 1 && d <= 7))) {
    throw new ConfigError('DIGEST_WEEKDAYS: dni tygodnia 1-7 (1 = poniedziałek), np. 1,2,3,4,5.');
  }
  const timeZone = env.TIMEZONE || 'Europe/Warsaw';
  try { new Intl.DateTimeFormat('pl', { timeZone }); } catch { throw new ConfigError(`TIMEZONE: nieznana strefa czasowa ${timeZone}.`); }

  // Tablica z przeciąganiem (strona w przeglądarce i Activity w Discordzie). Włącza się sekretem aplikacji.
  const clientSecret = (env.DISCORD_CLIENT_SECRET || '').trim() || null;
  let publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
  if (publicUrl) {
    let u;
    try { u = new URL(publicUrl); } catch { throw new ConfigError('PUBLIC_URL: podaj pełny adres, np. https://tablica.gameby.pl'); }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new ConfigError('PUBLIC_URL musi zaczynać się od https:// (http dozwolone tylko dla localhost).');
    if (u.pathname !== '/' || u.search || u.hash) throw new ConfigError('PUBLIC_URL to sam adres strony, bez ścieżki (np. https://tablica.gameby.pl).');
    publicUrl = u.origin;
  }
  // HTTP_PORT ma pierwszeństwo; PORT ustawia sama platforma hostingowa (Railway), więc bot go rozumie bez dodatkowych ustawień.
  const portVar = env.HTTP_PORT ? 'HTTP_PORT' : (env.PORT ? 'PORT' : null);
  const httpPort = parseInt(portVar ? env[portVar] : '8080', 10);
  if (!/^\d+$/.test(portVar ? env[portVar] : '8080') || httpPort < 1 || httpPort > 65535) throw new ConfigError(`${portVar || 'HTTP_PORT'}: numer portu 1-65535.`);
  const sessionHours = parseInt(env.SESSION_HOURS ?? '168', 10);
  if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24 * 30) throw new ConfigError('SESSION_HOURS: liczba godzin od 1 do 720.');

  // Skąd brać adres klienta za serwerem pośredniczącym (ma znaczenie tylko przy TRUST_PROXY=1):
  // cloudflare = tunel Cloudflare (nagłówek CF-Connecting-IP), railway = brama Railway (nagłówek X-Real-IP, który brama sama nadpisuje).
  const proxyType = (env.PROXY_TYPE || 'cloudflare').toLowerCase();
  if (!['cloudflare', 'railway'].includes(proxyType)) throw new ConfigError('PROXY_TYPE: cloudflare albo railway.');

  // Jednorazowe przeniesienie pliku stanu na nowy hosting: JSON zakodowany w base64, używany tylko gdy pliku stanu jeszcze nie ma.
  let stateSeed = null;
  if (env.STATE_SEED_B64) {
    const raw = env.STATE_SEED_B64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ConfigError('STATE_SEED_B64: to nie jest tekst w base64 (skopiuj całą jedną linię).');
    try { stateSeed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { stateSeed = null; }
    if (!stateSeed || typeof stateSeed !== 'object' || Array.isArray(stateSeed)) throw new ConfigError('STATE_SEED_B64: po zdekodowaniu to nie jest plik stanu (JSON z obiektem).');
  }

  // Rozliczenia z osobami piszącymi: kto je prowadzi (zarząd), od kogo jest protokół i dokąd go odsyłać.
  // Bez FINANCE_USER_IDS funkcja jest wyłączona: stawki i kwoty nie są wtedy nigdzie zbierane ani pokazywane.
  const financeUserIds = [];
  for (const raw of String(env.FINANCE_USER_IDS || '').split(',')) {
    const id = raw.trim();
    if (!id) continue;
    if (!/^\d{15,25}$/.test(id)) throw new ConfigError('FINANCE_USER_IDS: numery osób z zarządu (same cyfry), oddzielone przecinkami.');
    if (!financeUserIds.includes(id)) financeUserIds.push(id);
  }
  const returnEmail = (env.PROTOCOL_RETURN_EMAIL || '').trim() || null;
  if (returnEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(returnEmail)) throw new ConfigError('PROTOCOL_RETURN_EMAIL: podaj adres e-mail, np. rozliczenia@gameby.pl.');

  return {
    token,
    guildId,
    web: {
      enabled: Boolean(clientSecret),
      clientSecret,
      publicUrl,
      port: httpPort,
      sessionMs: sessionHours * 3600 * 1000,
      // Za Cloudflare Tunnel adres klienta jest w nagłówku; bez tego ograniczenia liczby zapytań widziałyby tylko tunel.
      trustProxy: bool(env.TRUST_PROXY, false),
      proxyType,
      // Przycisk "Otwórz w Discordzie" na tablicy (wymaga włączonych Activities w Developer Portal).
      activity: bool(env.ACTIVITY, false),
      // Lista wszystkich osób z dostępem do forum w oknie przydziału (wymaga Server Members Intent w Developer Portal).
      membersIntent: bool(env.MEMBERS_INTENT, false),
    },
    finance: {
      userIds: financeUserIds,
      issuer: (env.PROTOCOL_ISSUER || 'GameBy.pl').trim().slice(0, 80),
      returnEmail,
      title: (env.PROTOCOL_TITLE || 'Protokół rozliczenia tekstów').trim().slice(0, 80),
    },
    forumId: (env.FORUM_ID || '').trim() || null,
    forumName: (env.FORUM_NAME || 'artykuly').trim(),
    digestEnabled: bool(env.DIGEST_ENABLED, true),
    digestChannelId: (env.DIGEST_CHANNEL_ID || '').trim() || null,
    digestChannelName: (env.DIGEST_CHANNEL_NAME || 'ogolne').trim(),
    digestHour: hour,
    digestWeekdays: weekdays,
    digestPing: bool(env.DIGEST_PING, false),
    timeZone,
    // Uprawnienie uprzywilejowane: włącz też "Message Content Intent" w Developer Portal.
    messageContent: bool(env.MESSAGE_CONTENT, false),
    registerCommands: bool(env.REGISTER_COMMANDS, true),
    stateFile: env.STATE_FILE || '/data/state.json',
    stateSeed,
    // Zwłoka przed odświeżeniem żywej tablicy po zmianie (łączy serię zmian w jedną aktualizację).
    boardDebounceMs: Math.max(0, parseInt(env.BOARD_DEBOUNCE_MS ?? '2000', 10) || 0),
  };
}

module.exports = { loadConfig, ConfigError };
