'use strict';
// Autor: Mateusz Bartoszewicz
// Fałszywy Discord do testów end-to-end: REST v10 + Gateway (WebSocket) w jednym procesie.
// Odtwarza tylko to, czego używa bot, ale w kształcie zgodnym z dokumentacją API.
const http = require('node:http');
const { WebSocketServer } = require('ws');

const ID = {
  guild: '100000000000000001', app: '100000000000000900',
  rRedakcja: '100000000000000101', rSzef: '100000000000000102', rBot: '100000000000000103',
  chCat: '100000000000000201', forum: '100000000000000202', ogolne: '100000000000000203', pogaduszki: '100000000000000204',
  autor: '100000000000001001', szef: '100000000000001002', obcy: '100000000000001003', oliwia: '100000000000001004',
};
const TAGS = [
  ['Pomysł', 301], ['Przydzielone', 302], ['W pisaniu', 303], ['Do redakcji', 304], ['Do publikacji', 305], ['Opublikowane', 306],
  ['Technologia', 310], ['Planszówki', 311], ['News', 312], ['Evergreen', 313], ['Cosplay i konwenty', 314],
].map(([name, n]) => ({ id: `100000000000000${n}`, name, moderated: name === 'Do publikacji' || name === 'Opublikowane', emoji_id: null, emoji_name: null }));
const tagId = (name) => TAGS.find((t) => t.name === name).id;

const P = { VIEW: 1n << 10n, SEND: 1n << 11n, MANAGE_THREADS: 1n << 34n, ADMIN: 1n << 3n };

class FakeDiscord {
  constructor({ tags = TAGS } = {}) {
    this.ID = ID;
    this.tags = tags;
    this.seq = 0;
    this.n = 0;
    this.sockets = new Set();
    this.intents = 0;
    this.requests = []; // {method, path, body}
    this.interactions = new Map(); // token -> {events, last}
    this.failures = []; // {re, status}
    this.commands = null;
    this.channels = [];
    this.threads = [];
    this.messages = new Map(); // channelId -> [message]
    this.botRoles = [ID.rBot];
    this.seed();
  }

  newId() { this.n += 1; return `200000000000${String(this.n).padStart(6, '0')}`; }

  user(id, name) { return { id, username: name, discriminator: '0', global_name: name, avatar: null, bot: id === ID.app }; }

  seed() {
    const ow = [{ id: ID.guild, type: 0, allow: '0', deny: String(P.VIEW) }, { id: ID.rRedakcja, type: 0, allow: String(P.VIEW), deny: '0' }];
    const base = (id, type, name, extra = {}) => ({
      id, type, guild_id: ID.guild, name, position: 0, parent_id: null, permission_overwrites: [], nsfw: false, flags: 0, ...extra,
    });
    this.channels = [
      base(ID.chCat, 4, 'REDAKCJA', { permission_overwrites: ow }),
      base(ID.forum, 15, 'artykuly', {
        parent_id: ID.chCat, permission_overwrites: ow, topic: 'Zadania', available_tags: this.tags,
        default_reaction_emoji: null, default_sort_order: 0, default_forum_layout: 1, flags: 16, rate_limit_per_user: 0,
      }),
      base(ID.ogolne, 0, 'ogolne', { parent_id: ID.chCat, permission_overwrites: ow, topic: '', rate_limit_per_user: 0 }),
      base(ID.pogaduszki, 0, 'pogaduszki', { topic: '', rate_limit_per_user: 0 }),
    ];
    this.roles = [
      { id: ID.guild, name: '@everyone', permissions: String(P.VIEW | P.SEND), position: 0, color: 0, hoist: false, managed: false, mentionable: false },
      { id: ID.rRedakcja, name: 'Redakcja', permissions: '0', position: 1, color: 0, hoist: false, managed: false, mentionable: false },
      { id: ID.rSzef, name: 'Szef redakcji', permissions: String(P.MANAGE_THREADS), position: 2, color: 0, hoist: false, managed: false, mentionable: false },
      { id: ID.rBot, name: 'kanbanbot', permissions: String(P.ADMIN), position: 3, color: 0, hoist: false, managed: true, mentionable: false },
    ];
  }

  // ---------------------------------------------------------------- dane testowe
  addThread({ name, owner = ID.autor, status = 'Pomysł', topics = [], archived = false, archivedAt = null, content = '', parent = ID.forum, id = null }) {
    const tid = id || this.newId();
    const applied = [...(status ? [tagId(status)] : []), ...topics.map(tagId)];
    const thread = {
      id: tid, type: 11, guild_id: ID.guild, parent_id: parent, owner_id: owner, name, last_message_id: tid, message_count: 1,
      member_count: 1, rate_limit_per_user: 0, total_message_sent: 1, flags: 0, applied_tags: applied,
      thread_metadata: { archived, auto_archive_duration: 10080, archive_timestamp: (archivedAt ? new Date(archivedAt) : new Date()).toISOString(), locked: false },
    };
    this.threads.push(thread);
    this.messages.set(tid, [this.makeMessage(tid, tid, owner === ID.app ? ID.app : owner, content)]);
    return thread;
  }

  makeMessage(id, channelId, authorId, content, extra = {}) {
    return {
      id, channel_id: channelId, author: this.user(authorId, authorId === ID.app ? 'kanbanbot' : `u${authorId.slice(-4)}`),
      content, timestamp: new Date().toISOString(), edited_timestamp: null, tts: false, mention_everyone: false,
      mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0, components: [], flags: 0, ...extra,
    };
  }

  thread(id) { return this.threads.find((t) => t.id === id); }

  // Dodatkowy kanał tekstowy; hidden = niewidoczny dla @everyone (jak kategoria REDAKCJA).
  addTextChannel(name, { hidden = false, first = false } = {}) {
    const ow = hidden ? [{ id: ID.guild, type: 0, allow: '0', deny: String(P.VIEW) }, { id: ID.rRedakcja, type: 0, allow: String(P.VIEW), deny: '0' }] : [];
    const ch = {
      id: this.newId(), type: 0, guild_id: ID.guild, name, position: 0, parent_id: null, permission_overwrites: ow,
      nsfw: false, flags: 0, topic: '', rate_limit_per_user: 0,
    };
    if (first) this.channels.unshift(ch); else this.channels.push(ch);
    return ch;
  }

  // Prawdziwy Discord nie wysyła applied_tags w obiekcie kanału dołączonym do interakcji.
  interactionChannel(id) {
    const ch = this.channelPayload(id);
    if (!ch || !ch.applied_tags) return ch;
    const { applied_tags: _omit, ...rest } = ch;
    return rest;
  }

  closeSockets(code, reason = 'test') {
    for (const ws of this.sockets) ws.close(code, reason);
  }

  knownUser(userId) { return [ID.autor, ID.oliwia, ID.szef, ID.obcy].includes(userId); }

  member(userId) {
    const map = {
      [ID.autor]: { roles: [ID.rRedakcja], perms: P.VIEW | P.SEND },
      [ID.oliwia]: { roles: [ID.rRedakcja], perms: P.VIEW | P.SEND },
      [ID.szef]: { roles: [ID.rRedakcja, ID.rSzef], perms: P.VIEW | P.SEND | P.MANAGE_THREADS },
      [ID.obcy]: { roles: [], perms: P.VIEW | P.SEND },
    }[userId];
    return {
      user: this.user(userId, `u${userId.slice(-4)}`), roles: map.roles, joined_at: new Date().toISOString(),
      deaf: false, mute: false, flags: 0, nick: null, permissions: String(map.perms), pending: false,
    };
  }

  // ---------------------------------------------------------------- start / stop
  async start() {
    this.server = http.createServer((req, res) => this.onHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onSocket(ws));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }

  async close() {
    for (const ws of this.sockets) ws.terminate();
    await new Promise((r) => this.wss.close(r));
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }

  get apiBase() { return `http://127.0.0.1:${this.port}/api`; }

  // ---------------------------------------------------------------- Gateway
  send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  dispatch(type, data) {
    this.seq += 1;
    for (const ws of this.sockets) this.send(ws, { op: 0, t: type, s: this.seq, d: data });
  }

  guildPayload() {
    return {
      id: ID.guild, name: 'Test GameBy', icon: null, owner_id: ID.szef, roles: this.roles, emojis: [], stickers: [],
      features: ['COMMUNITY'], premium_tier: 0, member_count: 5, large: false, unavailable: false, joined_at: new Date().toISOString(),
      preferred_locale: 'pl', verification_level: 2, channels: this.channels, threads: this.threads.filter((t) => !t.thread_metadata.archived),
      members: [{ user: this.user(ID.app, 'kanbanbot'), roles: this.botRoles, joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 }],
      presences: [], voice_states: [], stage_instances: [], guild_scheduled_events: [],
    };
  }

  onSocket(ws) {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    this.send(ws, { op: 10, d: { heartbeat_interval: 30000 } });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.op === 1) this.send(ws, { op: 11 });
      if (msg.op === 2) {
        this.intents = msg.d.intents;
        this.seq += 1;
        this.send(ws, {
          op: 0, t: 'READY', s: this.seq,
          d: {
            v: 10, user: this.user(ID.app, 'kanbanbot'), guilds: [{ id: ID.guild, unavailable: true }], session_id: 'sess1',
            resume_gateway_url: `ws://127.0.0.1:${this.port}`, application: { id: ID.app, flags: 0 }, shard: [0, 1],
          },
        });
        this.seq += 1;
        this.send(ws, { op: 0, t: 'GUILD_CREATE', s: this.seq, d: this.guildPayload() });
      }
    });
  }

  // Bez Message Content Intent Discord zwraca pustą treść cudzych wiadomości.
  masked(msg) {
    const hasIntent = (this.intents & (1 << 15)) !== 0;
    if (hasIntent || msg.author.id === ID.app) return msg;
    return { ...msg, content: '' };
  }

  // ---------------------------------------------------------------- interakcje
  async interact(payload, { idle = 250, timeout = 6000 } = {}) {
    const token = `tok-${this.newId()}`;
    const id = this.newId();
    // Odpowiedź typu "aktualizacja wiadomości" (6/7) zmienia wiadomość, na której kliknięto; zapamiętujemy ją.
    const rec = { events: [], last: Date.now(), target: payload.message ? { channelId: payload.channel_id, id: payload.message.id } : null };
    this.interactions.set(token, rec);
    const base = {
      id, application_id: ID.app, token, version: 1, guild_id: ID.guild, locale: 'pl', guild_locale: 'pl', app_permissions: String(P.ADMIN),
      entitlements: [], authorizing_integration_owners: {}, context: 0,
    };
    this.dispatch('INTERACTION_CREATE', { ...base, ...payload });
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await new Promise((r) => setTimeout(r, 25));
      const first = rec.events[0];
      const terminal = rec.events.some((e) => e.kind === 'edit' || e.kind === 'followup' || e.kind === 'delete');
      // Po odroczeniu odpowiedzi komendy (typ 5) czekamy na właściwą odpowiedź, a nie tylko na ciszę.
      const waitForTerminal = first && first.kind === 'callback' && first.type === 5 && !terminal;
      if (rec.events.length && !waitForTerminal && Date.now() - rec.last > idle) break;
    }
    return rec.events;
  }

  channelPayload(id) {
    return this.threads.find((t) => t.id === id) || this.channels.find((c) => c.id === id);
  }

  command(userId, name, options = [], channelId = ID.ogolne, guildId = ID.guild, extra = {}) {
    const users = {};
    for (const o of options) if (o.type === 6) users[o.value] = this.user(o.value, `u${o.value.slice(-4)}`);
    return this.interact({
      type: 2, guild_id: guildId, channel_id: channelId, channel: this.interactionChannel(channelId),
      member: this.member(userId),
      data: { id: '100000000000000999', name, type: 1, options, ...(Object.keys(users).length ? { resolved: { users } } : {}) },
    }, extra);
  }

  // Kliknięcie przycisku (type 2), menu tekstowego (3) albo menu osób (5) na wiadomości z kartą.
  // Domyślnie klikana jest ostatnia wiadomość bota z komponentami w tym kanale.
  component(userId, channelId, customId, { values, type = 3, messageId } = {}) {
    const ch = this.channelPayload(channelId);
    const msgs = this.messages.get(channelId) || [];
    const target = (messageId && msgs.find((m) => m.id === messageId))
      || [...msgs].reverse().find((m) => m.author.id === ID.app && m.components && m.components.length);
    const message = target || this.makeMessage(this.newId(), channelId, ID.app, 'Status', { components: [] });
    const users = {};
    if (type === 5) for (const v of values || []) users[v] = this.user(v, `u${v.slice(-4)}`);
    return this.interact({
      type: 3, channel_id: channelId, channel: this.interactionChannel(ch.id), member: this.member(userId), message,
      data: {
        custom_id: customId, component_type: type, ...(values ? { values } : {}),
        ...(Object.keys(users).length ? { resolved: { users } } : {}),
      },
    });
  }

  // Wysłanie okna (modala). fields: {id: tekst | [id osób]}. legacy = pola w wierszach akcji (stary format).
  // fromMessage: okno otwarte przyciskiem na wiadomości (wtedy interakcja ma `message`).
  modalSubmit(userId, channelId, customId, fields, { legacy = false, fromMessage = true, messageId } = {}) {
    const ch = this.channelPayload(channelId);
    const msgs = this.messages.get(channelId) || [];
    const target = (messageId && msgs.find((m) => m.id === messageId))
      || [...msgs].reverse().find((m) => m.author.id === ID.app && m.components && m.components.length);
    const users = {};
    const comps = Object.entries(fields).map(([id, v], i) => {
      if (Array.isArray(v)) {
        for (const u of v) users[u] = this.user(u, `u${u.slice(-4)}`);
        return { type: 18, id: i + 1, component: { type: 5, id: 100 + i, custom_id: id, values: v } };
      }
      const inner = { type: 4, id: 100 + i, custom_id: id, value: v };
      return legacy ? { type: 1, id: i + 1, components: [inner] } : { type: 18, id: i + 1, component: inner };
    });
    return this.interact({
      type: 5, channel_id: channelId, channel: this.interactionChannel(ch.id), member: this.member(userId),
      ...(fromMessage ? { message: target || this.makeMessage(this.newId(), channelId, ID.app, 'x', { components: [] }) } : {}),
      data: { custom_id: customId, components: comps, ...(Object.keys(users).length ? { resolved: { users } } : {}) },
    });
  }

  // ---------------------------------------------------------------- REST
  onHttp(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      const url = new URL(req.url, 'http://x');
      const path = decodeURIComponent(url.pathname).replace(/^\/api\/v10/, '');
      this.requests.push({ method: req.method, path, body, query: Object.fromEntries(url.searchParams) });
      // failures: {re, status, code?, after?}. `after` = ile pasujących żądań ma przejść bez błędu, zanim jedno dostanie błąd.
      const fail = this.failures.findIndex((f) => f.re.test(`${req.method} ${path}`) && !(f.after > 0 && (f.after -= 1, true)));
      if (fail >= 0) {
        const f = this.failures.splice(fail, 1)[0];
        res.writeHead(f.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Fake failure', code: f.code ?? 0 }));
        return;
      }
      try {
        const out = this.route(req.method, path, body, url.searchParams);
        if (out === undefined) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: `Unknown route ${req.method} ${path}`, code: 0 })); return; }
        if (out === null) { res.writeHead(204); res.end(); return; }
        if (out.__error) { res.writeHead(out.__error.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: out.__error.message, code: out.__error.code })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: String(err.stack || err), code: 0 }));
      }
    });
  }

  event(token, kind, payload) {
    const rec = this.interactions.get(token);
    if (rec) { rec.events.push({ kind, ...payload }); rec.last = Date.now(); }
  }

  route(method, path, body, query) {
    let m;
    if (method === 'GET' && path === '/gateway/bot') {
      return { url: `ws://127.0.0.1:${this.port}`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } };
    }
    if (method === 'GET' && path === `/guilds/${ID.guild}`) return { ...this.guildPayload(), channels: undefined, threads: undefined, members: undefined };
    if (method === 'GET' && path === `/guilds/${ID.guild}/channels`) return this.channels;
    if (method === 'GET' && path === `/guilds/${ID.guild}/threads/active`) {
      return { threads: this.threads.filter((t) => !t.thread_metadata.archived), members: [] };
    }
    if (method === 'GET' && (m = /^\/channels\/(\d+)\/threads\/archived\/public$/.exec(path))) {
      // Jak w Discordzie: od najnowszej archiwizacji, `before` to znacznik czasu archiwizacji, `limit` do 100.
      const limit = Math.min(+(query.get('limit') || 50), 100);
      const before = query.get('before') ? Date.parse(query.get('before')) : Infinity;
      const all = this.threads
        .filter((t) => t.parent_id === m[1] && t.thread_metadata.archived && Date.parse(t.thread_metadata.archive_timestamp) < before)
        .sort((a, b) => Date.parse(b.thread_metadata.archive_timestamp) - Date.parse(a.thread_metadata.archive_timestamp));
      return { threads: all.slice(0, limit), members: [], has_more: all.length > limit };
    }
    if (method === 'GET' && (m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
      const msg = (this.messages.get(m[1]) || []).find((x) => x.id === m[2]);
      return msg ? this.masked(msg) : undefined;
    }
    const unknownMessage = { __error: { status: 404, code: 10008, message: 'Unknown Message' } };
    if (method === 'PATCH' && (m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
      const msg = (this.messages.get(m[1]) || []).find((x) => x.id === m[2]);
      if (!msg) return unknownMessage;
      if (msg.author.id !== ID.app) return { __error: { status: 403, code: 50005, message: 'Cannot edit a message authored by another user' } };
      if (body.content !== undefined) msg.content = body.content;
      if (body.embeds !== undefined) msg.embeds = body.embeds;
      if (body.components !== undefined) msg.components = body.components;
      if (body.allowed_mentions !== undefined) msg.allowed_mentions = body.allowed_mentions;
      msg.edited_timestamp = new Date().toISOString();
      this.edits = [...(this.edits || []), { channelId: m[1], id: m[2], body }];
      return msg;
    }
    if (method === 'DELETE' && (m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
      const list = this.messages.get(m[1]) || [];
      const idx = list.findIndex((x) => x.id === m[2]);
      if (idx < 0) return unknownMessage;
      list.splice(idx, 1);
      this.deletes = [...(this.deletes || []), { channelId: m[1], id: m[2] }];
      return null;
    }
    if (method === 'GET' && path === `/guilds/${ID.guild}/members`) {
      const after = query.get('after');
      const limit = Math.min(+(query.get('limit') || 1), 1000);
      const ids = [ID.autor, ID.szef, ID.oliwia, ID.obcy].filter((id) => !after || BigInt(id) > BigInt(after)).slice(0, limit);
      return ids.map((id) => this.member(id));
    }
    if (method === 'GET' && (m = /^\/guilds\/(\d+)\/members\/(\d+)$/.exec(path))) {
      if (!this.knownUser(m[2])) return { __error: { status: 404, code: 10007, message: 'Unknown Member' } };
      return this.member(m[2]);
    }
    if (method === 'GET' && (m = /^\/channels\/(\d+)$/.exec(path))) return this.channelPayload(m[1]);
    if (method === 'PATCH' && (m = /^\/channels\/(\d+)$/.exec(path))) {
      const th = this.thread(m[1]);
      if (!th) return undefined;
      if (body.applied_tags) th.applied_tags = body.applied_tags;
      if (body.archived !== undefined) th.thread_metadata.archived = body.archived;
      this.dispatch('THREAD_UPDATE', th);
      return th;
    }
    if (method === 'POST' && (m = /^\/channels\/(\d+)\/threads$/.exec(path))) {
      const forum = this.channels.find((c) => c.id === m[1] && c.type === 15);
      if (!forum) return undefined;
      if (forum.flags & 16 && !(body.applied_tags || []).length) throw new Error('Forum wymaga co najmniej jednego tagu');
      const th = this.addThread({ name: body.name, owner: ID.app, status: null, content: body.message.content, parent: m[1] });
      th.applied_tags = body.applied_tags || [];
      this.created = [...(this.created || []), { thread: th, body }];
      const out = { ...th, message: this.messages.get(th.id)[0] };
      setTimeout(() => this.dispatch('THREAD_CREATE', { ...th, newly_created: true }), 10);
      return out;
    }
    if (method === 'POST' && (m = /^\/channels\/(\d+)\/messages$/.exec(path))) {
      const msg = this.makeMessage(this.newId(), m[1], ID.app, body.content || '', { embeds: body.embeds || [], components: body.components || [] });
      msg.allowed_mentions = body.allowed_mentions;
      this.messages.set(m[1], [...(this.messages.get(m[1]) || []), msg]);
      return msg;
    }
    if (method === 'PUT' && (m = new RegExp(`^/applications/${ID.app}/guilds/${ID.guild}/commands$`).exec(path))) {
      this.commands = body;
      return body.map((c, i) => ({ ...c, id: `1000000000000009${String(i).padStart(2, '0')}`, application_id: ID.app, guild_id: ID.guild, version: '1' }));
    }
    if (method === 'POST' && (m = /^\/interactions\/(\d+)\/([^/]+)\/callback$/.exec(path))) {
      this.event(m[2], 'callback', { type: body.type, data: body.data });
      return null;
    }
    if (method === 'PATCH' && (m = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(path))) {
      const rec = this.interactions.get(m[2]);
      const first = rec && rec.events[0];
      if (rec && rec.target && first && first.kind === 'callback' && first.type === 6) {
        const stored = (this.messages.get(rec.target.channelId) || []).find((x) => x.id === rec.target.id);
        if (stored) {
          if (body.content !== undefined) stored.content = body.content;
          if (body.embeds !== undefined) stored.embeds = body.embeds;
          if (body.components !== undefined) stored.components = body.components;
        }
      }
      this.event(m[2], 'edit', { body });
      return this.makeMessage(this.newId(), ID.ogolne, ID.app, body.content || '', { embeds: body.embeds || [] });
    }
    if (method === 'POST' && (m = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path))) {
      // Jak w Discordzie: pierwszy follow-up po odroczeniu odpowiedzi (typ 5) zastępuje wiadomość "bot myśli",
      // dziedziczy jej prywatność, a flagi z follow-upu są ignorowane.
      const rec = this.interactions.get(m[2]);
      const first = rec && rec.events[0];
      if (first && first.kind === 'callback' && first.type === 5 && !rec.events.some((e) => e.kind === 'edit')) {
        this.event(m[2], 'edit', { body, viaFollowup: true });
        return this.makeMessage(this.newId(), ID.ogolne, ID.app, body.content || '', { embeds: body.embeds || [] });
      }
      this.event(m[2], 'followup', { body });
      return this.makeMessage(this.newId(), ID.ogolne, ID.app, body.content || '', { embeds: body.embeds || [] });
    }
    if (method === 'DELETE' && (m = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(path))) {
      this.event(m[2], 'delete', {});
      return null;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- pomocnicze do asercji
  messagesOf(channelId) { return this.messages.get(channelId) || []; }
  requestsTo(method, re) { return this.requests.filter((r) => r.method === method && re.test(r.path)); }
}

module.exports = { FakeDiscord, ID, TAGS, tagId, P };
