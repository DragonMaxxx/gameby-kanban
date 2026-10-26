'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, ID } = require('./helpers');

test('start: bot loguje się, rejestruje 7 komend, sprawdza tagi', async () => {
  const t = await boot();
  try {
    assert.deepEqual(t.fake.commands.map((c) => c.name).sort(), ['edytuj', 'panel', 'podsumowanie', 'rozliczenia', 'tablica', 'ustaw-tablice', 'zadanie']);
    assert.ok(t.logs.log.some((l) => /tagi statusu są na miejscu/.test(l)), t.logs.log.join('\n'));
    assert.ok(t.logs.log.some((l) => /Żywa tablica nie jest ustawiona/.test(l)), 'podpowiedź o /ustaw-tablice');
    assert.deepEqual(t.logs.warn, []);
    assert.deepEqual(t.logs.error, []);
    assert.equal(t.app.client.user.id, ID.app);
  } finally { await t.close(); }
});

// index.js nie ma własnych testów (łączy się z prawdziwym Discordem), więc pilnujemy przynajmniej tego, żeby minutowy harmonogram wołał wszystkie zadania cykliczne.
test('index.js: minutowy harmonogram wywołuje podsumowanie dnia, żywą tablicę i rozliczenia', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const tick = /setInterval\(\(\) => \{([^}]*)\}, 60 \* 1000\)/.exec(src);
  assert.ok(tick, 'harmonogram co minutę istnieje');
  for (const fn of ['digestTick', 'liveTick', 'financeTick']) assert.match(tick[1], new RegExp(`bot\\.${fn}\\(\\)`), fn);
});

// Testy e2e wywołują podkomendy wprost po nazwie, więc osobno pilnujemy tego, co Discord faktycznie dostaje przy rejestracji komend.
test('rejestracja: /rozliczenia ma podkomendy i opcje, których używają przyciski, README i testy', async () => {
  const t = await boot();
  try {
    const cmd = t.fake.commands.find((c) => c.name === 'rozliczenia');
    const shape = Object.fromEntries(cmd.options.map((sc) => [sc.name, (sc.options || []).map((o) => `${o.name}:${o.type}${o.required ? '!' : ''}`)]));
    assert.deepEqual(shape, {
      stawka: ['osoba:6!', 'kwota:3!', 'imie:3'],
      stawki: [],
      premia: ['kwota:3!', 'opis:3'],
      social: ['kwota:3!'],
      szkic: ['miesiac:3'],
    });
    assert.ok(cmd.options.every((sc) => sc.type === 1), 'same podkomendy');
    assert.ok(!cmd.options.some((sc) => /brutto|netto/i.test(JSON.stringify(sc))), 'opisy nie obiecują przeliczeń na brutto ani netto');
  } finally { await t.close(); }
});
