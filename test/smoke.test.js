'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, ID } = require('./helpers');

test('start: bot loguje się, rejestruje 6 komend, sprawdza tagi', async () => {
  const t = await boot();
  try {
    assert.deepEqual(t.fake.commands.map((c) => c.name).sort(), ['edytuj', 'panel', 'podsumowanie', 'tablica', 'ustaw-tablice', 'zadanie']);
    assert.ok(t.logs.log.some((l) => /tagi statusu są na miejscu/.test(l)), t.logs.log.join('\n'));
    assert.ok(t.logs.log.some((l) => /Żywa tablica nie jest ustawiona/.test(l)), 'podpowiedź o /ustaw-tablice');
    assert.deepEqual(t.logs.warn, []);
    assert.deepEqual(t.logs.error, []);
    assert.equal(t.app.client.user.id, ID.app);
  } finally { await t.close(); }
});
