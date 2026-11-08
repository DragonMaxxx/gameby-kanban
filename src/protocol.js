'use strict';
// Autor: Mateusz Bartoszewicz
// Protokół rozliczenia jednej osoby jako PDF (A4). Czcionka DejaVu Sans jest dołączona, bo wbudowane czcionki PDF nie mają polskich znaków.
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { formatMoney, formatHours, monthLabel, lastDayOf, HOURS_PER_TEXT } = require('./finance');

const FONT = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');

const INK = '#1a1a1a';
const MUTED = '#5c5c5c';
const LINE = '#b8b8b8';
const HEAD_BG = '#eeeeee';

const plDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

// data: { month, issuer, returnEmail, title, preparedAt, person: {name, rate, texts[], bonuses[], textsTotal, bonusTotal, total, hours} }
function renderProtocol(data) {
  return new Promise((resolve, reject) => {
    const { month, person } = data;
    const issuer = data.issuer || 'GameBy.pl';
    const title = `${data.title || 'Protokół rozliczenia tekstów'}${data.supplement ? ' (uzupełnienie)' : ''}`;
    const label = monthLabel(month);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 54, bottom: 64, left: 50, right: 50 },
      bufferPages: true,
      info: {
        Title: `${title} – ${label} – ${person.name}`,
        Author: issuer,
        Subject: `Rozliczenie za ${label}`,
      },
    });
    doc.registerFont('Sans', FONT);
    doc.registerFont('Bold', FONT_BOLD);

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;
      const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
      const ensure = (h) => { if (doc.y + h > bottomLimit()) doc.addPage(); };
      const hr = (y, color = LINE) => doc.save().moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor(color).stroke().restore();

      // ---- nagłówek
      doc.font('Bold').fontSize(17).fillColor(INK).text(title, left, doc.y, { width });
      doc.font('Sans').fontSize(11).fillColor(MUTED).text(`za miesiąc: ${label}`, { width });
      doc.moveDown(0.8);

      const info = [
        ['Zleceniodawca', issuer],
        ['Osoba rozliczana', person.name],
        ['Okres', `${plDate(`${month}-01`)} – ${plDate(lastDayOf(month))}`],
        ['Data sporządzenia', plDate(data.preparedAt)],
      ];
      for (const [k, v] of info) {
        const y = doc.y;
        doc.font('Sans').fontSize(9.5).fillColor(MUTED).text(k, left, y, { width: 120 });
        doc.font('Bold').fontSize(10).fillColor(INK).text(v, left + 125, y, { width: width - 125 });
      }
      doc.moveDown(0.8);

      doc.font('Sans').fontSize(9.5).fillColor(INK).text(
        'Poniżej zestawienie tekstów z terminem oddania w wymienionym miesiącu (tekst bez terminu liczy się według dnia przekazania do redakcji). '
        + `Za każdy tekst liczymy ${formatHours(HOURS_PER_TEXT)} pracy. `
        + 'Prosimy o sprawdzenie, czy zestawienie jest kompletne i zgodne z Twoją wiedzą, podpisanie i odesłanie'
        + (data.returnEmail ? ` na adres ${data.returnEmail}.` : ' do redakcji.')
        + ' Jeśli czegoś brakuje lub coś się nie zgadza, napisz w uwagach albo do nas przed podpisaniem.',
        left, doc.y, { width, lineGap: 1.5 },
      );
      doc.moveDown(1);

      // ---- tabela
      const drawTable = (heading, columns, rows, emptyText) => {
        ensure(60);
        doc.font('Bold').fontSize(11).fillColor(INK).text(heading, left, doc.y, { width });
        doc.moveDown(0.4);

        const cellPad = 4;
        const headerRow = () => {
          const y = doc.y;
          doc.save().rect(left, y, width, 20).fill(HEAD_BG).restore();
          let x = left;
          doc.font('Bold').fontSize(8.5).fillColor(INK);
          for (const c of columns) {
            doc.text(c.label, x + cellPad, y + 6, { width: c.w - 2 * cellPad, align: c.align || 'left', lineBreak: false });
            x += c.w;
          }
          doc.y = y + 20;
          hr(doc.y);
        };
        headerRow();

        if (!rows.length) {
          doc.font('Sans').fontSize(9).fillColor(MUTED).text(emptyText, left + cellPad, doc.y + 6, { width: width - 2 * cellPad });
          doc.y += 8;
          hr(doc.y);
          doc.moveDown(0.8);
          return;
        }

        doc.font('Sans').fontSize(9);
        for (const row of rows) {
          const h = Math.max(...columns.map((c, i) => doc.heightOfString(String(row[i]), { width: c.w - 2 * cellPad }))) + 10;
          if (doc.y + h > bottomLimit()) {
            doc.addPage();
            headerRow();
            doc.font('Sans').fontSize(9);
          }
          const y = doc.y;
          let x = left;
          doc.fillColor(INK);
          columns.forEach((c, i) => {
            doc.text(String(row[i]), x + cellPad, y + 5, { width: c.w - 2 * cellPad, align: c.align || 'left' });
            x += c.w;
          });
          doc.y = y + h;
          hr(doc.y, '#dddddd');
        }
        doc.moveDown(0.9);
      };

      drawTable(
        'Teksty oddane do redakcji',
        [
          { label: 'Lp.', w: 30 },
          { label: 'Tytuł tekstu', w: 205 },
          { label: 'Termin', w: 70 },
          { label: 'Godz.', w: 40, align: 'right' },
          { label: 'Stawka', w: 75, align: 'right' },
          { label: 'Kwota', w: 75, align: 'right' },
        ],
        person.texts.map((t, i) => [i + 1, t.title, plDate(t.date), String(HOURS_PER_TEXT), formatMoney(t.rate), formatMoney(t.amount)]),
        'Brak tekstów z terminem w tym miesiącu.',
      );

      if (person.bonuses.length) {
        drawTable(
          'Premie i dodatki',
          [
            { label: 'Lp.', w: 30 },
            { label: 'Tekst', w: 190 },
            { label: 'Za co', w: 125 },
            { label: 'Kwota', w: 150, align: 'right' },
          ],
          person.bonuses.map((b, i) => [i + 1, b.title, b.note || '–', formatMoney(b.amount)]),
          '',
        );
      }

      // ---- podsumowanie, godziny i podpis zawsze na jednej stronie: podpisana kartka musi zawierać kwotę
      ensure(310);
      const sumRows = [
        [`Teksty (${person.texts.length})`, formatMoney(person.textsTotal)],
        [`Premie i dodatki (${person.bonuses.length})`, formatMoney(person.bonusTotal)],
      ];
      for (const [k, v] of sumRows) {
        const y = doc.y;
        doc.font('Sans').fontSize(10).fillColor(INK).text(k, left + width - 270, y, { width: 150 });
        doc.text(v, left + width - 115, y, { width: 115, align: 'right' });
        doc.y = y + 16;
      }
      hr(doc.y + 2, INK);
      doc.y += 8;
      {
        const y = doc.y;
        doc.font('Bold').fontSize(11.5).fillColor(INK).text('Razem do wypłaty', left + width - 270, y, { width: 150 });
        doc.text(formatMoney(person.total), left + width - 115, y, { width: 115, align: 'right' });
        doc.y = y + 22;
      }

      // ---- godziny, uwagi, podpis (zawsze razem, żeby podpis nie został sam na stronie)
      doc.moveDown(0.6);
      const field = (text, lines) => {
        doc.font('Sans').fontSize(9.5).fillColor(INK).text(text, left, doc.y, { width });
        doc.moveDown(0.2);
        for (let i = 0; i < lines; i += 1) {
          doc.y += 20;
          hr(doc.y, '#888888');
        }
        doc.y += 10;
      };
      {
        const hours = Number.isInteger(person.hours) ? person.hours : person.texts.length * HOURS_PER_TEXT;
        doc.font('Sans').fontSize(9.5).fillColor(INK).text('Liczba godzin pracy w miesiącu: ', left, doc.y, { width, continued: true })
          .font('Bold').text(formatHours(hours), { continued: true })
          .font('Sans').text(` (${formatHours(HOURS_PER_TEXT)} za każdy tekst).`);
        doc.y += 14;
      }
      field('Uwagi (czego brakuje, co się nie zgadza):', 2);

      doc.y += 4;
      const sigY = doc.y + 26;
      doc.save().moveTo(left, sigY).lineTo(left + 200, sigY).lineWidth(0.6).strokeColor('#888888').stroke()
        .moveTo(left + width - 200, sigY).lineTo(left + width, sigY).stroke().restore();
      doc.font('Sans').fontSize(8.5).fillColor(MUTED)
        .text('Data i podpis osoby rozliczanej', left, sigY + 4, { width: 200 })
        .text(`Za zleceniodawcę (${issuer})`, left + width - 200, sigY + 4, { width: 200, align: 'right' });

      // ---- stopka z numerami stron na każdej stronie
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const bm = doc.page.margins.bottom;
        doc.page.margins.bottom = 0; // inaczej pdfkit zakłada nową stronę przy tekście tuż nad krawędzią
        doc.font('Sans').fontSize(8).fillColor(MUTED).text(
          `${issuer} · ${label} · ${person.name}`,
          left, doc.page.height - 38, { width: width - 80, lineBreak: false },
        );
        doc.text(`Strona ${i + 1} z ${range.count}`, left + width - 80, doc.page.height - 38, { width: 80, align: 'right', lineBreak: false });
        doc.page.margins.bottom = bm;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderProtocol, plDate };
