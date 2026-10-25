'use strict';
// Autor: Mateusz Bartoszewicz
// Wspólne narzędzia testów strony: bot z fałszywym Discordem, fałszywy OAuth2 i prosty klient HTTP.
const assert = require('node:assert/strict');
const net = require('node:net');
const { boot, ID } = require('./helpers');
const { FakeOAuth } = require('./fake-oauth');

const NOW = new Date('2026-10-24T10:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); }
  return fn();
}
// Prawdziwy obrazek 1x1 (przeglądarka go wyrenderuje), żeby zrzuty ekranu nie pokazywały uszkodzonych awatarów.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BOARD_ENV = { BOARD_DEBOUNCE_MS: '30' };

function seed(fake) {
  const a = fake.addThread({ name: 'Recenzja A', owner: ID.autor, status: 'W pisaniu', topics: ['Technologia'], content: '' });
  const c = fake.addThread({ name: 'Pomysł C', owner: ID.autor, status: 'Pomysł', content: '' });
  const e = fake.addThread({ name: 'Do pub E', owner: ID.szef, status: 'Do publikacji', content: '' });
  const d = fake.addThread({ name: 'Stary D', owner: ID.autor, status: 'Opublikowane', archived: true, content: '' });
  const f = fake.addThread({ name: 'Pełny F', owner: ID.autor, status: 'Pomysł', topics: ['Technologia', 'Planszówki', 'News', 'Evergreen', 'Cosplay i konwenty'], content: '' });
  return { a, c, e, d, f };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// localUrl: PUBLIC_URL wskazuje na ten sam adres, pod którym stoi serwer testowy (http://127.0.0.1:port), żeby przeglądarka
// mogła przejść pełne logowanie i wysyłać zmiany z poprawnym nagłówkiem Origin.
async function bootWeb({ env = {}, seedFn = seed, authMembers, publicDir, localUrl = false } = {}) {
  const oauth = await new FakeOAuth({
    clientId: ID.app, clientSecret: 'sekret', guildId: ID.guild, members: authMembers || [ID.autor, ID.szef, ID.oliwia, ID.obcy],
  }).start();
  const listenPort = localUrl ? await freePort() : 0;
  const t = await boot({
    env: {
      DISCORD_CLIENT_SECRET: 'sekret', PUBLIC_URL: localUrl ? `http://127.0.0.1:${listenPort}` : 'https://tablica.test', MESSAGE_CONTENT: '0', ...BOARD_ENV, ...env,
    },
    now: () => NOW,
    seed: seedFn,
    webOptions: {
      discordApi: oauth.base, port: listenPort, fetchAvatar: async () => PNG, ...(publicDir ? { publicDir } : {}),
      // W testach przeglądarkowych strona zgody jest nasza (przeglądarka nie ma jak dojść do prawdziwego discord.com).
      ...(localUrl ? { authorizeUrl: `${oauth.base}/oauth2/authorize` } : {}),
    },
  });
  const site = t.app.site();
  const port = site.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (session, method, url, body, headers = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      redirect: 'manual',
      headers: { ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers, res };
  };
  const login = async (userId) => {
    const r = await call(null, 'POST', '/api/token', { code: `code-${userId}` });
    assert.equal(r.status, 200, `logowanie ${userId}: ${r.text}`);
    return r.json.session;
  };
  const close = async () => { await t.close(); await oauth.close(); };
  return { ...t, oauth, site, port, base, call, login, close };
}

const taskIn = (board, name) => board.json.tasks.find((x) => x.name === name);
const cardsIn = (fake, id) => fake.messagesOf(id).filter((m) => m.components && m.components.length);

module.exports = { NOW, sleep, waitFor, PNG, BOARD_ENV, seed, bootWeb, taskIn, cardsIn, freePort };
