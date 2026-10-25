'use strict';
// Autor: Mateusz Bartoszewicz
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FakeDiscord, ID } = require('./fake-discord');
const { main } = require('../src/index');

async function boot({ env = {}, fakeOpts = {}, now, seed, webOptions } = {}) {
  const fake = await new FakeDiscord(fakeOpts).start();
  if (seed) seed(fake);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
  const logs = { log: [], warn: [], error: [] };
  const log = {
    log: (m) => logs.log.push(String(m)), warn: (m) => logs.warn.push(String(m)), error: (m) => logs.error.push(String(m)),
  };
  const app = await main({
    env: { DISCORD_TOKEN: 'test-token', GUILD_ID: ID.guild, STATE_FILE: path.join(dir, 'state.json'), MESSAGE_CONTENT: '1', ...env },
    clientOptions: { rest: { api: fake.apiBase } },
    scheduler: false,
    log,
    now,
    ...(webOptions ? { webOptions } : {}),
  });
  const close = async () => { await app.stop(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { fake, app, logs, close, stateFile: path.join(dir, 'state.json') };
}

const opt = (name, value, type = 3) => ({ name, type, value });
const flagsOf = (ev) => ev.data && ev.data.flags;
const EPHEMERAL = 64;

module.exports = { boot, opt, flagsOf, EPHEMERAL, ID };
