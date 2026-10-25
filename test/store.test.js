'use strict';
// Autor: Mateusz Bartoszewicz
// Plik stanu: zapis atomowy, odczyt po restarcie i jednorazowe przeniesienie stanu z innego hostingu (STATE_SEED_B64).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');

const quiet = () => {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(`log: ${m}`), error: (m) => lines.push(`error: ${m}`), warn: (m) => lines.push(`warn: ${m}`) } };
};
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-store-'));
  return { dir, file: path.join(dir, 'data', 'state.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const SEED = { tasks: { 111: { a: '222', d: '2026-11-05', u: true, c: '333' } }, lastDigest: '2026-10-23', board: { header: '444' } };

test('store: zapis i odczyt po restarcie, katalog powstaje sam, nie zostaje plik tymczasowy', () => {
  const t = tmp();
  try {
    const a = createStore(t.file);
    a.set('lastDigest', '2026-10-24');
    assert.equal(createStore(t.file).get('lastDigest'), '2026-10-24');
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['state.json']);
  } finally { t.cleanup(); }
});

test('store: stan początkowy trafia na dysk tylko gdy pliku jeszcze nie ma', () => {
  const t = tmp();
  try {
    const q = quiet();
    const first = createStore(t.file, { seed: SEED, log: q.log });
    assert.equal(first.seeded, true);
    assert.deepEqual(first.get('tasks'), SEED.tasks);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, 'utf8')), SEED, 'plik zapisany od razu, nie dopiero przy pierwszej zmianie');
    assert.match(q.lines.join('\n'), /Wczytano stan początkowy/);

    // Bot zmienia stan, potem restart z tym samym (zostawionym w ustawieniach) ziarnem: nic się nie cofa.
    first.set('lastDigest', '2026-10-26');
    const q2 = quiet();
    const second = createStore(t.file, { seed: SEED, log: q2.log });
    assert.equal(second.seeded, false);
    assert.equal(second.get('lastDigest'), '2026-10-26', 'ziarno nie nadpisuje nowszego stanu');
    assert.match(q2.lines.join('\n'), /już istnieje/);
  } finally { t.cleanup(); }
});

test('store: ziarno nie jest współdzielone z zapisanym stanem (zmiana nie rusza obiektu z ustawień)', () => {
  const t = tmp();
  try {
    const seed = { tasks: {} };
    const s = createStore(t.file, { seed, log: quiet().log });
    s.set('lastDigest', 'x');
    assert.equal('lastDigest' in seed, false);
  } finally { t.cleanup(); }
});

test('store: gdy nie da się zapisać ziarna, bot startuje dalej z pustym stanem i zgłasza błąd', () => {
  const t = tmp();
  try {
    fs.writeFileSync(path.join(t.dir, 'data'), 'to jest plik, nie katalog'); // katalog stanu nie może powstać
    const q = quiet();
    const s = createStore(t.file, { seed: SEED, log: q.log });
    assert.equal(s.seeded, false);
    assert.match(q.lines.join('\n'), /error: Nie mogę zapisać stanu początkowego/);
  } finally { t.cleanup(); }
});
