'use strict';
// Autor: Mateusz Bartoszewicz
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const OK = { DISCORD_TOKEN: 'abc.def', GUILD_ID: '123456789012345678' };

test('config: wartości domyślne', () => {
  const c = loadConfig(OK);
  assert.equal(c.forumName, 'artykuly');
  assert.equal(c.digestChannelName, 'ogolne');
  assert.equal(c.digestHour, 9);
  assert.deepEqual(c.digestWeekdays, [1, 2, 3, 4, 5]);
  assert.equal(c.timeZone, 'Europe/Warsaw');
  assert.equal(c.messageContent, false);
  assert.equal(c.digestPing, false);
  assert.equal(c.digestEnabled, true);
  assert.equal(c.stateFile, '/data/state.json');
});

test('config: końce linii CRLF z pliku .env Windows nie psują wartości', () => {
  const c = loadConfig({ DISCORD_TOKEN: 'abc.def\r', GUILD_ID: '123456789012345678\r', MESSAGE_CONTENT: '1\r', DIGEST_HOUR: '8\r', DIGEST_WEEKDAYS: '1,3\r' });
  assert.equal(c.token, 'abc.def');
  assert.equal(c.guildId, '123456789012345678');
  assert.equal(c.messageContent, true);
  assert.equal(c.digestHour, 8);
  assert.deepEqual(c.digestWeekdays, [1, 3]);
});

test('config: brakujące i błędne wartości dają czytelne błędy', () => {
  assert.throws(() => loadConfig({ GUILD_ID: '123456789012345678' }), /DISCORD_TOKEN/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'x' }), /GUILD_ID/);
  assert.throws(() => loadConfig({ ...OK, GUILD_ID: 'abc' }), /same cyfry/);
  assert.throws(() => loadConfig({ ...OK, DIGEST_HOUR: '25' }), /DIGEST_HOUR/);
  assert.throws(() => loadConfig({ ...OK, DIGEST_WEEKDAYS: '0,9' }), /DIGEST_WEEKDAYS/);
  assert.throws(() => loadConfig({ ...OK, MESSAGE_CONTENT: 'tak' }), /logiczna/);
  assert.throws(() => loadConfig({ ...OK, TIMEZONE: 'Mars/Olympus' }), /strefa/);
});
