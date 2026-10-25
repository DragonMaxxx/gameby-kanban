'use strict';
// Autor: Mateusz Bartoszewicz
// Serwer HTTP tablicy z przeciąganiem kart. Ta sama strona działa w przeglądarce (logowanie kontem Discorda)
// i jako Activity w Discordzie. Dane i reguły uprawnień zostają w bocie: serwer tylko sprawdza, kim jest użytkownik,
// i przekazuje polecenia do bot.web.* (te same funkcje, z których korzystają przyciski na karcie).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { pipeline } = require('node:stream');
const { DiscordAPIError } = require('discord.js');
const { STATUSES, RESTRICTED, WRITING_DONE } = require('../board');
const { UserError } = require('../bot');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const SESSION_COOKIE = 'gb_sess';
const STATE_COOKIE = 'gb_oauth';
const MAX_BODY = 16 * 1024;
const MAX_SESSIONS = 2000;
const SNOWFLAKE = /^\d{15,25}$/;
// Kody OAuth2 Discorda to krótkie ciągi znaków alfanumerycznych. Sprawdzamy format, zanim zapytamy Discorda, żeby śmieci nic nie kosztowały.
const CODE_FORMAT = /^[A-Za-z0-9._~-]{1,300}$/;
// Wspólny budżet wymian kodu na token (po wszystkich adresach): ochrona limitów Discorda dla adresu serwera przed zalewem z wielu adresów.
const GLOBAL_OAUTH_PER_MIN = 120;
const AVATAR_TTL_MS = 6 * 3600 * 1000;
const AVATAR_FAIL_TTL_MS = 60 * 1000;
const GENERIC_ERROR = 'Coś poszło nie tak. Spróbuj za chwilę, a jeśli się powtórzy, zgłoś to osobie, która obsługuje bota.';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Porównanie stałoczasowe wartości o dowolnej długości (skróty mają tę samą długość, więc timingSafeEqual nigdy nie rzuca wyjątku).
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

// If-None-Match może zawierać kilka wartości i słabe walidatory (W/"..."), które serwery pośredniczące potrafią dopisać po kompresji.
function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  const bare = (v) => v.trim().replace(/^W\//, '');
  if (header.trim() === '*') return true;
  return header.split(',').some((v) => bare(v) === bare(etag));
}

// Adres do limitów zapytań. IPv6 liczymy po prefiksie /64 (jedna sieć domowa ma ich miliardy), IPv4-w-IPv6 jako zwykłe IPv4.
function limiterKeyForIp(ip) {
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return 'nieznany';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  let head = ip.toLowerCase();
  const zone = head.indexOf('%');
  if (zone >= 0) head = head.slice(0, zone);
  const [left, right] = head.split('::');
  const l = left ? left.split(':') : [];
  const r = right !== undefined && right ? right.split(':') : [];
  const groups = right === undefined ? l : [...l, ...Array(Math.max(0, 8 - l.length - r.length)).fill('0'), ...r];
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}
const randomId = () => crypto.randomBytes(32).toString('base64url');

// Stały limit zapytań w oknie czasu (na adres albo sesję). Wystarczy do ochrony przed pętlą w przeglądarce lub prostym nadużyciem.
const MAX_LIMITER_KEYS = 20000;
function createLimiter() {
  const hits = new Map();
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, 60 * 1000);
  timer.unref();
  return {
    take(key, limit, windowMs) {
      const t = Date.now();
      let h = hits.get(key);
      if (!h || h.reset <= t) {
        // Mapa nie rośnie bez końca nawet przy ruchu z tysięcy różnych adresów: najpierw usuwamy wygasłe wpisy, a gdy to za mało, najstarsze.
        if (!h && hits.size >= MAX_LIMITER_KEYS) {
          for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
          while (hits.size >= MAX_LIMITER_KEYS) hits.delete(hits.keys().next().value);
        }
        h = { count: 0, reset: t + windowMs };
        hits.set(key, h);
      }
      h.count += 1;
      return h.count <= limit;
    },
    stop: () => clearInterval(timer),
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Domyślne pobieranie awatara: tylko z CDN Discorda, mały obrazek, krótki czas oczekiwania. Wynik jako data: URI,
// bo Activity nie może sięgać do obcych domen bez ustawień w Developer Portal.
async function fetchAvatarDefault(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'cdn.discordapp.com') return null;
  const res = await fetch(u, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 150 * 1024) return null;
  return `data:${type};base64,${buf.toString('base64')}`;
}

function createWebServer({
  bot, config, log = console, clientId, discordApi = DISCORD_API, authorizeUrl = DISCORD_AUTHORIZE, fetchImpl = fetch, fetchAvatar = fetchAvatarDefault,
  publicDir = path.join(__dirname, '..', '..', 'public'), port = config.web.port,
}) {
  const web = config.web;
  const secureCookies = Boolean(web.publicUrl) && web.publicUrl.startsWith('https:');
  const limiter = createLimiter();
  const sessions = new Map(); // id sesji -> {userId, exp}
  const avatars = new Map(); // adres obrazka -> {until, data}
  const redirectUri = web.publicUrl ? `${web.publicUrl}/auth/callback` : null;

  // ---------------------------------------------------------------- sesje
  function createSession(userId) {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.exp <= now) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = randomId();
    sessions.set(id, { userId, exp: now + web.sessionMs });
    return id;
  }

  // Sesja z nagłówka Authorization (Activity) albo z ciasteczka (przeglądarka).
  function sessionOf(req) {
    const auth = req.headers.authorization || '';
    const bearer = /^Bearer ([A-Za-z0-9_-]{20,80})$/.exec(auth);
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const id = bearer ? bearer[1] : (cookie && /^[A-Za-z0-9_-]{20,80}$/.test(cookie) ? cookie : null);
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (s.exp <= Date.now()) { sessions.delete(id); return null; }
    return { id, userId: s.userId, viaCookie: !bearer };
  }

  // ---------------------------------------------------------------- Discord OAuth2
  async function discordFetch(url, init = {}) {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) });
  }

  async function exchangeCode(code, withRedirect) {
    const body = new URLSearchParams({
      client_id: clientId, client_secret: web.clientSecret, grant_type: 'authorization_code', code,
    });
    if (withRedirect) body.set('redirect_uri', redirectUri);
    const res = await discordFetch(`${discordApi}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!res.ok) throw new HttpError(401, 'Logowanie nie powiodło się. Spróbuj jeszcze raz.');
    const data = await res.json();
    if (!data || typeof data.access_token !== 'string') throw new HttpError(401, 'Logowanie nie powiodło się. Spróbuj jeszcze raz.');
    return data.access_token;
  }

  // Token użytkownika służy tylko do ustalenia, kim jest (jego numer i członkostwo na serwerze), po czym go nie przechowujemy.
  async function userIdFor(accessToken) {
    const res = await discordFetch(`${discordApi}/users/@me/guilds/${config.guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404 || res.status === 403) throw new HttpError(403, 'Ta tablica jest tylko dla redakcji.');
    if (!res.ok) throw new HttpError(401, 'Logowanie nie powiodło się. Spróbuj jeszcze raz.');
    const member = await res.json();
    const id = member && member.user && member.user.id;
    if (!SNOWFLAKE.test(String(id))) throw new HttpError(401, 'Logowanie nie powiodło się. Spróbuj jeszcze raz.');
    return id;
  }

  async function revokeToken(accessToken) {
    try {
      await discordFetch(`${discordApi}/oauth2/token/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: web.clientSecret, token: accessToken, token_type_hint: 'access_token' }),
      });
    } catch { /* odwołanie tokenu to dodatkowe zabezpieczenie, nie warunek logowania */ }
  }

  // ---------------------------------------------------------------- pomocnicze odpowiedzi
  const baseHeaders = () => ({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });

  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    // Strona ma się otwierać w Discordzie (Activity), ale nie na obcych stronach.
    `frame-ancestors 'self' https://discord.com https://*.discord.com https://${clientId}.discordsays.com`,
  ].join('; ');

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...baseHeaders(), ...headers });
    res.end(body);
  }

  function sendJson(res, status, obj, headers = {}) {
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  }

  function cookie(name, value, { maxAgeSec, path: p = '/' } = {}) {
    const parts = [`${name}=${value}`, `Path=${p}`, 'HttpOnly', 'SameSite=Lax'];
    if (secureCookies) parts.push('Secure');
    if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
    return parts.join('; ');
  }

  // Nagłówki od serwera pośredniczącego są brane pod uwagę tylko przy TRUST_PROXY=1 i tylko jeśli są prawdziwym adresem IP
  // (klucz limitu nie może być dowolnym tekstem). Z X-Forwarded-For bierzemy ostatni wpis, czyli ten dopisany przez najbliższy zaufany serwer.
  // Który nagłówek jest wiarygodny, zależy od tego, co stoi przed botem (PROXY_TYPE): tunel Cloudflare dopisuje CF-Connecting-IP,
  // a brama Railway nadpisuje X-Real-IP i X-Forwarded-For. Nagłówka drugiej usługi nie czytamy, bo przy innym ustawieniu mógłby go podrobić każdy.
  function clientIp(req) {
    let ip = null;
    if (web.trustProxy) {
      const header = (name) => {
        const v = req.headers[name];
        return typeof v === 'string' && net.isIP(v.trim()) ? v.trim() : null;
      };
      ip = header(web.proxyType === 'railway' ? 'x-real-ip' : 'cf-connecting-ip');
      const xff = req.headers['x-forwarded-for'];
      if (!ip && typeof xff === 'string' && xff) {
        const last = xff.split(',').pop().trim();
        if (net.isIP(last)) ip = last;
      }
    }
    return limiterKeyForIp(ip || req.socket.remoteAddress || '');
  }

  async function readJson(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Oczekiwano application/json.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Za duże zapytanie.');
      chunks.push(chunk);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      return v;
    } catch { throw new HttpError(400, 'Nieprawidłowe dane.'); }
  }

  const str = (v, max, { required = false, name = 'pole' } = {}) => {
    if (v === undefined || v === null || v === '') {
      if (required) throw new HttpError(400, `Brakuje: ${name}.`);
      return '';
    }
    if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `Nieprawidłowe: ${name}.`);
    return v;
  };
  const snowflake = (v, name, { nullable = false } = {}) => {
    if ((v === null || v === undefined || v === '') && nullable) return null;
    if (typeof v !== 'string' || !SNOWFLAKE.test(v)) throw new HttpError(400, `Nieprawidłowe: ${name}.`);
    return v;
  };

  // ---------------------------------------------------------------- błędy
  function toHttp(err) {
    if (err instanceof HttpError) return { status: err.status, message: err.message };
    if (err instanceof UserError) return { status: err.status || 400, message: err.message };
    if (err instanceof DiscordAPIError && (err.code === 50001 || err.code === 50013)) {
      return { status: 502, message: 'Bot nie ma wystarczających uprawnień na forum (szczegóły w logu bota).' };
    }
    return { status: 500, message: GENERIC_ERROR };
  }

  // ---------------------------------------------------------------- trasy
  function requireSession(req) {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, 'Zaloguj się ponownie.');
    if (!limiter.take(`s:${s.id}`, 240, 60 * 1000)) throw new HttpError(429, 'Za dużo zapytań. Poczekaj chwilę.');
    return s;
  }

  // Ciasteczko wysyła przeglądarka sama, więc zmiany z ciasteczkiem muszą pochodzić z naszej strony (nagłówek Origin).
  // Activity używa nagłówka Authorization, którego obca strona nie może dołączyć.
  function requireSameOrigin(req, s) {
    if (!s.viaCookie || req.method === 'GET' || req.method === 'HEAD') return;
    if (!web.publicUrl || req.headers.origin !== web.publicUrl) throw new HttpError(403, 'Nieprawidłowe źródło zapytania.');
  }

  async function login(userId, { activity }) {
    const actor = await bot.web.actor(userId); // odmowa już tutaj dla osób bez dostępu do forum
    const id = createSession(userId);
    log.log(`Strona z tablicą: zalogowano ${actor.user.tag}${activity ? ' (Activity)' : ''}.`);
    return id;
  }

  async function avatarFor(url) {
    const hit = avatars.get(url);
    if (hit && Date.now() < hit.until) return hit.data;
    let data = null;
    try { data = await fetchAvatar(url); } catch { data = null; }
    // Udane pobranie pamiętamy długo, nieudane tylko chwilę (chwilowa awaria CDN nie może zabrać awatara na pół dnia).
    avatars.set(url, { until: Date.now() + (data ? AVATAR_TTL_MS : AVATAR_FAIL_TTL_MS), data });
    if (avatars.size > 500) avatars.delete(avatars.keys().next().value);
    return data;
  }

  function etagged(req, res, payload) {
    const body = JSON.stringify(payload);
    const etag = `"${sha1(body)}"`;
    if (etagMatches(req.headers['if-none-match'], etag)) { send(res, 304, '', { ETag: etag, 'Cache-Control': 'no-store' }); return; }
    send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ETag: etag });
  }

  async function handleApi(req, res, pathname) {
    const method = req.method;
    if (pathname === '/api/config' && method === 'GET') {
      sendJson(res, 200, { clientId, web: Boolean(web.publicUrl), statuses: STATUSES, restricted: [...RESTRICTED] });
      return;
    }
    if (pathname === '/api/token' && method === 'POST') {
      if (!limiter.take(`ip:${clientIp(req)}:tok`, 30, 60 * 1000)) throw new HttpError(429, 'Za dużo prób logowania.');
      const body = await readJson(req);
      const code = str(body.code, 300, { required: true, name: 'kod' });
      if (!CODE_FORMAT.test(code)) throw new HttpError(400, 'Nieprawidłowy kod logowania.');
      if (!limiter.take('global:oauth', GLOBAL_OAUTH_PER_MIN, 60 * 1000)) throw new HttpError(429, 'Za dużo prób logowania.');
      const accessToken = await exchangeCode(code, false);
      const userId = await userIdFor(accessToken);
      const session = await login(userId, { activity: true });
      sendJson(res, 200, { access_token: accessToken, session, expires_in: Math.floor(web.sessionMs / 1000) });
      return;
    }
    if (pathname === '/api/logout' && method === 'POST') {
      const s = sessionOf(req);
      if (s) { requireSameOrigin(req, s); sessions.delete(s.id); }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAgeSec: 0 }) });
      return;
    }

    const s = requireSession(req);
    requireSameOrigin(req, s);
    const actor = await bot.web.actor(s.userId);

    if (pathname === '/api/board' && method === 'GET') {
      const [snap, me] = await Promise.all([bot.web.board(), bot.web.me(actor)]);
      const { rev: _rev, ...rest } = snap;
      etagged(req, res, { ...rest, me, statuses: STATUSES, restricted: [...RESTRICTED], writingDone: [...WRITING_DONE] });
      return;
    }
    if (pathname === '/api/people' && method === 'GET') {
      const list = await bot.web.people(actor);
      const out = await Promise.all(list.map(async (p) => ({ id: p.id, name: p.name, avatar: await avatarFor(p.avatarUrl) })));
      etagged(req, res, { people: out });
      return;
    }
    if (method !== 'POST') throw new HttpError(404, 'Nie ma takiej strony.');

    const body = await readJson(req);
    let task;
    switch (pathname) {
      case '/api/move': {
        const status = str(body.status, 40, { required: true, name: 'status' });
        task = await bot.web.move(actor, snowflake(body.id, 'zadanie'), status);
        break;
      }
      case '/api/take': task = await bot.web.take(actor, snowflake(body.id, 'zadanie')); break;
      case '/api/release': task = await bot.web.release(actor, snowflake(body.id, 'zadanie')); break;
      case '/api/assign': task = await bot.web.assign(actor, snowflake(body.id, 'zadanie'), snowflake(body.userId, 'osoba', { nullable: true })); break;
      case '/api/due': {
        // Brak pola nie znaczy "usuń termin" (to robi pusty tekst albo null): inaczej błąd w kliencie kasowałby terminy po cichu.
        // Pola due (oddanie tekstu) i pubDue (publikacja) są niezależne, ale trzeba podać co najmniej jedno.
        const given = (key) => Object.hasOwn(body, key);
        const valid = (key) => body[key] === null || typeof body[key] === 'string';
        if ((!given('due') && !given('pubDue')) || (given('due') && !valid('due')) || (given('pubDue') && !valid('pubDue'))) {
          throw new HttpError(400, 'Nieprawidłowe: termin.');
        }
        task = await bot.web.due(
          actor, snowflake(body.id, 'zadanie'),
          given('due') ? str(body.due, 10, { name: 'termin' }) : undefined,
          given('pubDue') ? str(body.pubDue, 10, { name: 'termin publikacji' }) : undefined,
        );
        break;
      }
      case '/api/urgent':
        if (typeof body.urgent !== 'boolean') throw new HttpError(400, 'Nieprawidłowe: priorytet.');
        task = await bot.web.urgent(actor, snowflake(body.id, 'zadanie'), body.urgent);
        break;
      case '/api/task': {
        const title = str(body.title, 100, { required: true, name: 'tytuł' }).trim();
        if (!title) throw new HttpError(400, 'Podaj tytuł zadania.');
        task = await bot.web.create(actor, {
          title,
          userId: snowflake(body.userId, 'osoba', { nullable: true }),
          due: str(body.due, 10, { name: 'termin' }),
          pubDue: str(body.pubDue, 10, { name: 'termin publikacji' }),
          description: str(body.description, 1500, { name: 'opis' }),
        });
        break;
      }
      default: throw new HttpError(404, 'Nie ma takiej strony.');
    }
    sendJson(res, 200, { task, rev: bot.web.revision() });
  }

  // Logowanie w przeglądarce: przekierowanie do Discorda i powrót z kodem.
  function handleAuthStart(req, res, url) {
    if (!web.publicUrl) { send(res, 404, 'Logowanie w przeglądarce nie jest włączone (brak PUBLIC_URL).', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    // Po przekroczeniu limitu wracamy na ekran logowania z komunikatem (goły tekst nie zostawiałby drogi powrotnej).
    if (!limiter.take(`ip:${clientIp(req)}:auth`, 40, 60 * 1000)) { send(res, 302, '', { Location: '/?blad=limit', 'Cache-Control': 'no-store' }); return; }
    const state = randomId();
    const q = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'identify guilds.members.read', state,
    });
    // Bez okna zgody, jeśli osoba już wcześniej zaakceptowała aplikację; przy pierwszym logowaniu Discord zwróci błąd i wrócimy tu z consent=1.
    if (url.searchParams.get('consent') !== '1') q.set('prompt', 'none');
    send(res, 302, '', {
      Location: `${authorizeUrl}?${q}`,
      'Set-Cookie': cookie(STATE_COOKIE, state, { maxAgeSec: 600, path: '/auth' }),
      'Cache-Control': 'no-store',
    });
  }

  async function handleAuthCallback(req, res, url) {
    const back = (code, extra = {}) => send(res, 302, '', {
      Location: `/?blad=${code}`, 'Cache-Control': 'no-store', 'Set-Cookie': cookie(STATE_COOKIE, '', { maxAgeSec: 0, path: '/auth' }), ...extra,
    });
    if (!web.publicUrl) { send(res, 404, 'Logowanie w przeglądarce nie jest włączone (brak PUBLIC_URL).', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    if (!limiter.take(`ip:${clientIp(req)}:auth`, 40, 60 * 1000)) { back('limit'); return; }
    const error = url.searchParams.get('error');
    if (error) {
      // Pierwsze logowanie bez okna zgody kończy się błędem: prosimy Discorda jeszcze raz, tym razem z oknem zgody.
      if (['consent_required', 'interaction_required', 'login_required'].includes(error)) {
        send(res, 302, '', { Location: '/auth/login?consent=1', 'Cache-Control': 'no-store', 'Set-Cookie': cookie(STATE_COOKIE, '', { maxAgeSec: 0, path: '/auth' }) });
        return;
      }
      back('odmowa');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const saved = parseCookies(req.headers.cookie)[STATE_COOKIE];
    if (!code || !state || !saved || !sameSecret(saved, state)) { back('stan'); return; }
    if (!CODE_FORMAT.test(code)) { back('logowanie'); return; }
    if (!limiter.take('global:oauth', GLOBAL_OAUTH_PER_MIN, 60 * 1000)) { back('limit'); return; }
    let accessToken = null;
    try {
      accessToken = await exchangeCode(code, true);
      const userId = await userIdFor(accessToken);
      const sid = await login(userId, { activity: false });
      send(res, 302, '', {
        Location: '/', 'Cache-Control': 'no-store',
        'Set-Cookie': [cookie(STATE_COOKIE, '', { maxAgeSec: 0, path: '/auth' }), cookie(SESSION_COOKIE, sid, { maxAgeSec: Math.floor(web.sessionMs / 1000) })],
      });
    } catch (err) {
      const { status } = toHttp(err);
      if (status >= 500) log.error(`Logowanie przez przeglądarkę nie wyszło: ${err.message}`);
      back(status === 403 ? 'dostep' : 'logowanie');
    } finally {
      if (accessToken) revokeToken(accessToken);
    }
  }

  // ---------------------------------------------------------------- pliki statyczne
  function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Metoda niedozwolona.', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (rel.split('/').some((seg) => seg === '' || seg.startsWith('.'))) { send(res, 404, 'Nie ma takiej strony.', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    const file = path.resolve(publicDir, rel);
    if (file !== path.join(path.resolve(publicDir), rel) || !file.startsWith(path.resolve(publicDir) + path.sep)) {
      send(res, 404, 'Nie ma takiej strony.', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) { send(res, 404, 'Nie ma takiej strony.', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
    if (etagMatches(req.headers['if-none-match'], etag)) { send(res, 304, '', headers); return; }
    res.writeHead(200, { ...baseHeaders(), ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    // pipeline zamyka plik także wtedy, gdy klient zerwie połączenie w trakcie (zwykłe pipe zostawiało otwarty deskryptor).
    pipeline(fs.createReadStream(file), res, () => {});
  }

  async function onRequest(req, res) {
    let url;
    // Adres musi być ścieżką. "//coś" parser uznałby za nazwę hosta i po cichu zamienił na "/".
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) { send(res, 400, 'Zły adres.', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    try { url = new URL(req.url, 'http://localhost'); } catch { send(res, 400, 'Zły adres.', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    // Activity wysyła zapytania przez serwer pośredniczący Discorda; część wersji dopisuje przedrostek /.proxy.
    const pathname = url.pathname.replace(/^\/\.proxy(?=\/)/, '');
    try {
      if (pathname === '/healthz') { send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return; }
      if (pathname === '/auth/login' && req.method === 'GET') { handleAuthStart(req, res, url); return; }
      if (pathname === '/auth/callback' && req.method === 'GET') { await handleAuthCallback(req, res, url); return; }
      if (pathname.startsWith('/api/')) { await handleApi(req, res, pathname); return; }
      handleStatic(req, res, pathname);
    } catch (err) {
      const { status, message } = toHttp(err);
      if (status >= 500) log.error(`Strona ${req.method} ${pathname}: ${err.stack || err.message}`);
      if (res.headersSent) { res.end(); return; }
      sendJson(res, status, { error: message });
    }
  }

  // Nieobsłużony wyjątek w jednym zapytaniu nie może zabić całego bota.
  const server = http.createServer({ connectionsCheckingInterval: 2000 }, (req, res) => {
    onRequest(req, res).catch((err) => {
      log.error(`Strona ${req.method}: nieobsłużony błąd: ${err.stack || err.message}`);
      try { if (!res.headersSent) sendJson(res, 500, { error: GENERIC_ERROR }); else res.destroy(); } catch { /* połączenie już zamknięte */ }
    });
  });
  server.requestTimeout = 20 * 1000;
  server.headersTimeout = 10 * 1000;
  // Dłuższy niż czas bezczynności po stronie tunelu (cloudflared trzyma połączenia do 90 s), żeby nie ucinać połączenia akurat wtedy, gdy tunel wysyła przez nie zapytanie.
  server.keepAliveTimeout = 95 * 1000;

  return {
    server,
    sessions,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: () => new Promise((resolve) => {
      limiter.stop();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

module.exports = { createWebServer, HttpError };
