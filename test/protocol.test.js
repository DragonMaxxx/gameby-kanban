'use strict';
// Autor: Mateusz Bartoszewicz
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderProtocol, plDate } = require('../src/protocol');

const person = (n) => {
  const texts = Array.from({ length: n }, (_, i) => ({ id: String(i), title: `Tekst ${i + 1} z polskimi znakami: ąćęłńóśźż`, date: '2026-10-05', rate: 12000, amount: 12000 }));
  const bonuses = [{ id: '1', title: 'Tekst 1', note: 'post na Facebooku', amount: 1500 }];
  const textsTotal = n * 12000;
  return { name: 'Żaneta Łącka', rate: 12000, texts, bonuses, textsTotal, bonusTotal: 1500, total: textsTotal + 1500 };
};
const pages = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

test('plDate: data ISO na zapis dd.mm.rrrr, śmieci na pusty tekst', () => {
  assert.equal(plDate('2026-10-05'), '05.10.2026');
  assert.equal(plDate('2026-10-05T10:00:00Z'), '05.10.2026');
  assert.equal(plDate(''), '');
  assert.equal(plDate(null), '');
  assert.equal(plDate('jutro'), '');
});

test('renderProtocol: poprawny, jednostronicowy PDF dla krótkiego zestawienia', async () => {
  const buf = await renderProtocol({ month: '2026-10', issuer: 'GameBy.pl', returnEmail: 'a@b.pl', preparedAt: '2026-11-02', person: person(3) });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(buf.subarray(-16).toString(), /%%EOF/);
  assert.ok(buf.length > 5000 && buf.length < 400000, `rozmiar ${buf.length}`); // czcionki są wycinane do użytych znaków
  assert.equal(pages(buf), 1);
});

test('renderProtocol: długie zestawienie dzieli się na strony, a pusty miesiąc też się renderuje', async () => {
  const many = await renderProtocol({ month: '2026-10', preparedAt: '2026-11-02', person: person(60) });
  assert.ok(pages(many) >= 3, `stron: ${pages(many)}`);
  const none = await renderProtocol({ month: '2026-10', preparedAt: '2026-11-02', person: { ...person(0), bonuses: [], bonusTotal: 0, total: 0 } });
  assert.equal(pages(none), 1);
});

test('renderProtocol: metadane PDF mają tytuł, autora i temat', async () => {
  const buf = await renderProtocol({ month: '2026-10', preparedAt: '2026-11-02', person: person(1) });
  const s = buf.toString('latin1');
  for (const key of ['Title', 'Author', 'Subject']) assert.match(s, new RegExp(`/${key} \\d+ 0 R`));
});

// Podpisana kartka musi zawierać kwotę: suma, godziny i podpis lądują na jednej stronie niezależnie od długości tabeli.
test('renderProtocol: suma i podpis są zawsze na tej samej stronie (także gdy tabela kończy się tuż przy dole)', async () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  let checked = 0;
  for (const n of [3, 12, 19, 20, 21, 22, 23, 38, 39, 40, 41]) {
    const buf = await renderProtocol({ month: '2026-10', preparedAt: '2026-11-02', person: person(n) });
    const file = path.join(os.tmpdir(), `kanban-layout-${process.pid}-${n}.pdf`);
    fs.writeFileSync(file, buf);
    try {
      const count = pages(buf);
      for (let p = 1; p <= count; p += 1) {
        const text = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', file, '-'], { encoding: 'utf8' });
        assert.equal(/Razem do wypłaty/.test(text), /Data i podpis osoby/.test(text), `n=${n}, strona ${p}: suma i podpis na różnych stronach`);
        if (/Razem do wypłaty/.test(text)) checked += 1;
      }
    } catch (err) {
      if (err.code === 'ENOENT') return; // bez pdftotext nie sprawdzimy układu stron
      throw err;
    } finally { fs.rmSync(file, { force: true }); }
  }
  assert.equal(checked, 11, 'w każdym protokole suma jest na dokładnie jednej stronie');
});

test('PDF: godziny wpisane przez bota, 2 za tekst, bez pustego pola do uzupełnienia', async () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const texts = [1, 2, 3].map((n) => ({ id: String(n), title: `Tekst ${n}`, url: '', date: `2026-10-0${n}`, rate: 15000, amount: 15000 }));
  const buf = await renderProtocol({
    month: '2026-10', issuer: 'GameBy.pl', returnEmail: 'r@gameby.pl', preparedAt: '2026-11-02',
    person: { name: 'Oliwia Nowak', rate: 15000, texts, bonuses: [], textsTotal: 45000, bonusTotal: 0, total: 45000, hours: 6 },
  });
  const file = path.join(os.tmpdir(), `godziny-${process.pid}.pdf`);
  fs.writeFileSync(file, buf);
  let text;
  try { text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }); } catch { return; } finally { fs.rmSync(file, { force: true }); }
  assert.match(text, /Liczba godzin pracy w miesiącu: 6 godzin \(2 godziny za każdy tekst\)/);
  assert.match(text, /Za każdy tekst liczymy 2 godziny pracy/);
  assert.doesNotMatch(text, /uzupełnia osoba rozliczana|dopisanie liczby godzin/);
  assert.match(text, /Godz\./);
});
