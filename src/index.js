'use strict';
// Autor: Mateusz Bartoszewicz
// Bot kanban dla redakcji GameBy.pl. Uruchomienie: node src/index.js (w Dockerze: docker compose up -d).
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { loadConfig, ConfigError } = require('./config');
const { createStore } = require('./store');
const { buildCommands } = require('./commands');
const { createBot } = require('./bot');
const { createWebServer } = require('./web/server');

// Kody zamknięcia bramki, po których samo ponawianie nie ma sensu (token, intenty).
const FATAL_CLOSE_CODES = new Map([
  [4004, 'Discord odrzucił token (mógł zostać zresetowany). Wklej nowy token do pliku .env.'],
  [4010, 'Nieprawidłowy numer shardu.'],
  [4011, 'Wymagany sharding.'],
  [4012, 'Nieprawidłowa wersja API.'],
  [4013, 'Nieprawidłowe intenty.'],
  [4014, 'Niedozwolone intenty: włącz "Message Content Intent" w Developer Portal albo ustaw MESSAGE_CONTENT=0.'],
]);

// Docker uruchamia bota ponownie po każdym zakończeniu. Przy błędzie tokenu lub intentów czekamy
// przed wyjściem, bo Discord resetuje token po 1000 logowań na dobę.
const FATAL_WAIT_MS = 10 * 60 * 1000;
const NETWORK_WAIT_MS = 30 * 1000;

async function main({
  env = process.env, clientOptions = {}, scheduler = true, log = console, now, onFatal, webOptions = {},
} = {}) {
  const config = loadConfig(env);
  const intents = [GatewayIntentBits.Guilds];
  if (config.messageContent) intents.push(GatewayIntentBits.MessageContent);
  if (config.web.enabled && config.web.membersIntent) intents.push(GatewayIntentBits.GuildMembers);
  // Domyślnie bot nikogo nie pinguje; wiadomości, które mają kogoś oznaczyć, mówią to wprost.
  const client = new Client({ intents, allowedMentions: { parse: [] }, ...clientOptions });
  const store = createStore(config.stateFile, { seed: config.stateSeed, log });
  const bot = createBot({ client, config, store, log, ...(now ? { now } : {}) });

  client.on(Events.InteractionCreate, (i) => { bot.onInteraction(i); });
  client.on(Events.ThreadCreate, (t, created) => { bot.onThreadCreate(t, created); });
  client.on(Events.ThreadUpdate, (before, after) => { bot.onThreadUpdate(before, after); });
  client.on(Events.ThreadDelete, (t) => { bot.onThreadDelete(t); });
  client.on(Events.Error, (err) => log.error(`Błąd klienta: ${err.message}`));
  client.on(Events.Warn, (msg) => log.warn(`Ostrzeżenie: ${msg}`));
  client.on(Events.ShardDisconnect, (event) => {
    const code = event && event.code;
    if (FATAL_CLOSE_CODES.has(code)) {
      log.error(`Discord zamknął połączenie (kod ${code}): ${FATAL_CLOSE_CODES.get(code)}`);
      if (onFatal) onFatal(code, client);
    } else {
      log.warn(`Połączenie z Discordem zamknięte (kod ${code}). Bot połączy się ponownie sam.`);
    }
  });

  let site = null; // serwer strony z tablicą (przeglądarka i Activity), tylko gdy podano DISCORD_CLIENT_SECRET
  const ready = new Promise((resolve) => {
    client.once(Events.ClientReady, async (c) => {
      log.log(`Zalogowano jako ${c.user.tag}.`);
      if (config.registerCommands) {
        try {
          await c.application.commands.set(buildCommands().map((cmd) => cmd.toJSON()), config.guildId);
          log.log('Zarejestrowano komendy: /tablica, /zadanie, /edytuj, /panel, /podsumowanie, /ustaw-tablice.');
        } catch (err) {
          log.error(`Nie udało się zarejestrować komend: ${err.message}`);
        }
      }
      await bot.selfCheck();
      if (config.web.enabled) {
        try {
          site = createWebServer({ bot, config, log, clientId: c.application.id, ...webOptions });
          const port = await site.listen();
          log.log(`Strona z tablicą: port ${port}${config.web.publicUrl ? `, adres ${config.web.publicUrl}` : ' (bez PUBLIC_URL: tylko Activity)'}.`);
        } catch (err) {
          site = null;
          log.error(`Nie udało się uruchomić strony z tablicą (bot działa dalej): ${err.message}`);
        }
      }
      if (scheduler) setInterval(() => { bot.digestTick(); bot.liveTick(); }, 60 * 1000).unref();
      resolve();
    });
  });

  await client.login(config.token);
  await ready;
  return {
    client, bot, config, site: () => site,
    stop: async () => { if (site) await site.close(); await client.destroy(); },
  };
}

if (require.main === module) {
  process.on('unhandledRejection', (err) => console.error('Nieobsłużony błąd:', err && err.stack ? err.stack : err));
  // docker stop wysyła SIGTERM: kończymy od razu, także gdy bot czeka po błędzie.
  let current = null;
  const stop = () => {
    console.log('Zatrzymuję bota.');
    const done = () => process.exit(0);
    if (current) current.stop().then(done, done); else done();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const exitLater = (ms) => {
    console.error(`Zamykam program za ${Math.round(ms / 1000)} s; Docker uruchomi go ponownie. Popraw ustawienia, żeby przerwać ten cykl.`);
    setTimeout(() => process.exit(1), ms);
  };
  main({
    onFatal: (code, client) => { client.destroy(); exitLater(FATAL_WAIT_MS); },
  }).then((app) => { current = app; }).catch((err) => {
    console.error(`Nie mogę uruchomić bota: ${err.message}`);
    if (err instanceof ConfigError) { process.exit(1); return; }
    if (/disallowed intents/i.test(err.message)) {
      console.error('Włącz "Message Content Intent" w Developer Portal (Bot -> Privileged Gateway Intents) albo ustaw MESSAGE_CONTENT=0.');
      exitLater(FATAL_WAIT_MS);
    } else if (/invalid token/i.test(err.message)) {
      console.error('Sprawdź DISCORD_TOKEN w pliku .env (token z Developer Portal -> Bot -> Reset Token, bez cudzysłowów i spacji).');
      exitLater(FATAL_WAIT_MS);
    } else {
      exitLater(NETWORK_WAIT_MS);
    }
  });
}

module.exports = { main };
