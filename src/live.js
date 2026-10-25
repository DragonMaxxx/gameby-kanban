'use strict';
// Autor: Mateusz Bartoszewicz
// Żywa tablica: kilka wiadomości bota na jednym kanale (nagłówek i po jednej na kolumnę), które bot sam edytuje,
// gdy coś się zmieni. Nie trzeba wpisywać komendy: wystarczy wejść na kanał.
const crypto = require('node:crypto');
const { DiscordAPIError, EmbedBuilder } = require('discord.js');
const B = require('./board');
const { headerPayload } = require('./ui');

const NO_MENTIONS = { parse: [] };
const REFRESH_EVERY_MS = 10 * 60 * 1000; // pełne odświeżenie co 10 minut

const isMissingMessage = (err) => err instanceof DiscordAPIError && (err.code === 10008 || err.status === 404);
const digest = (payload) => crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');

// collect: async () => ({tasks, today, note}).
// guard: async (channel) => tekst powodu albo null; sprawdzany przed każdym zapisem na kanale (np. czy kanał nie stał się publiczny).
// Zwraca obiekt z metodami setup, schedule, refreshNow, tick, info.
function createLiveBoard({ client, config, store, now, log, collect, guard = async () => null }) {
  const hashes = new Map(); // id wiadomości -> skrót ostatnio wysłanej treści
  let timer = null;
  let chain = Promise.resolve(); // wszystkie operacje na tablicy idą jedna po drugiej
  let active = 0;
  let refreshQueued = false;
  let lastFull = 0; // ostatnie pełne odświeżenie (wszystkie wiadomości edytowane, więc braki zostają wykryte)

  const state = () => store.get('board') || null;

  function exclusive(job) {
    active += 1;
    const p = chain.then(job);
    chain = p.catch(() => {}).then(() => { active -= 1; });
    return p;
  }

  function render({ tasks, today, note }) {
    const web = config.web || {};
    const extras = web.enabled ? { link: web.publicUrl || null, activity: Boolean(web.activity) } : {};
    const items = [{ key: 'header', payload: headerPayload(B.renderHeader(tasks, today, { note }), extras) }];
    for (const status of B.STATUSES) {
      items.push({ key: status, payload: { embeds: [B.renderColumn(status, tasks, today)], components: [], allowedMentions: NO_MENTIONS } });
    }
    return items;
  }

  const idFor = (board, key) => (key === 'header' ? board.headerId : (board.columnIds || {})[key]);
  const idsOf = (board) => [board.headerId, ...Object.values(board.columnIds || {})].filter(Boolean);

  // Treść do wysłania: nagłówek dostaje znacznik czasu ostatniej aktualizacji (nie wchodzi do skrótu).
  function outgoing(item) {
    if (item.key !== 'header') return { ...item.payload, embeds: item.payload.embeds.map((e) => new EmbedBuilder(e)) };
    const embed = new EmbedBuilder(item.payload.embeds[0]).setTimestamp(now());
    return { ...item.payload, embeds: [embed] };
  }

  async function removeMessages(channel, ids) {
    for (const id of ids) { try { await channel.messages.delete(id); } catch { /* już usunięta */ } hashes.delete(id); }
  }

  // Wysyła wszystkie wiadomości od nowa (nagłówek, potem kolumny), zapisuje nowy stan i dopiero wtedy usuwa stare.
  // Gdy wysyłka się nie uda, sprzątamy to, co już poszło, a stara tablica zostaje nietknięta.
  async function rebuild(channel, items, oldBoard) {
    const board = { channelId: channel.id, headerId: null, columnIds: {} };
    const sent = [];
    try {
      for (const item of items) {
        const msg = await channel.send(outgoing(item));
        sent.push(msg.id);
        if (item.key === 'header') board.headerId = msg.id; else board.columnIds[item.key] = msg.id;
        hashes.set(msg.id, digest(item.payload));
      }
    } catch (err) {
      await removeMessages(channel, sent);
      throw err;
    }
    store.set('board', board);
    lastFull = now().getTime();
    if (oldBoard) {
      const oldChannel = oldBoard.channelId === channel.id ? channel : await client.channels.fetch(oldBoard.channelId).catch(() => null);
      if (oldChannel && oldChannel.isTextBased()) await removeMessages(oldChannel, idsOf(oldBoard));
    }
    return board;
  }

  async function refresh() {
    const board = state();
    if (!board) return false;
    const channel = await client.channels.fetch(board.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      log.warn('Kanał żywej tablicy zniknął. Wejdź na kanał redakcji i wpisz /ustaw-tablice.');
      return false;
    }
    const reason = await guard(channel);
    if (reason) {
      log.error(`Żywa tablica wstrzymana: ${reason}. Tytuły zadań nie będą wysyłane na ten kanał. Popraw uprawnienia kanału albo wpisz /ustaw-tablice na innym.`);
      return false;
    }
    const items = render(await collect());
    const complete = board.headerId && items.every((i) => idFor(board, i.key));
    if (!complete) { await rebuild(channel, items, board); return true; }
    try {
      for (const item of items) {
        const id = idFor(board, item.key);
        const h = digest(item.payload);
        if (hashes.get(id) === h) continue;
        await channel.messages.edit(id, outgoing(item));
        hashes.set(id, h);
      }
    } catch (err) {
      if (!isMissingMessage(err)) throw err;
      log.warn('Ktoś usunął wiadomość żywej tablicy, wysyłam ją od nowa.');
      await rebuild(channel, items, board);
    }
    return true;
  }

  // Jedno odświeżenie naraz. Prośba, która przychodzi, gdy kolejne czeka już w kolejce, dołącza do niego
  // (zbierze najświeższe dane, bo startuje później); prośba w trakcie odświeżania ustawia nowe w kolejce.
  function refreshNow() {
    if (refreshQueued) return chain;
    refreshQueued = true;
    return exclusive(async () => {
      refreshQueued = false;
      try {
        await refresh();
      } catch (err) {
        log.error(`Odświeżanie żywej tablicy nie wyszło: ${err.detail || err.message}`);
      }
    });
  }

  function schedule() {
    if (!state() || timer) return;
    timer = setTimeout(() => { timer = null; refreshNow(); }, config.boardDebounceMs);
    if (timer.unref) timer.unref();
  }

  // Co 10 minut edytuje wszystkie wiadomości tablicy, nawet bez zmian: odświeża znacznik czasu i etykiety terminów
  // ("za 2 dni" -> "jutro") oraz wykrywa wiadomości usunięte ręcznie (bot nie nasłuchuje zdarzeń o wiadomościach).
  async function tick() {
    if (!state() || active || refreshQueued) return;
    if (now().getTime() - lastFull >= REFRESH_EVERY_MS) {
      hashes.clear();
      lastFull = now().getTime();
      await refreshNow();
    }
  }

  // Ustawia tablicę w podanym kanale i zastępuje poprzednią (tu albo w innym kanale). Najpierw pobiera dane i wysyła nową,
  // dopiero potem usuwa starą, więc przy błędzie stara tablica zostaje na miejscu.
  function setup(channel) {
    return exclusive(async () => {
      const items = render(await collect());
      await rebuild(channel, items, state());
    });
  }

  return { setup, schedule, refreshNow, tick, info: state };
}

module.exports = { createLiveBoard };
