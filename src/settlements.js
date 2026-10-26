'use strict';
// Autor: Mateusz Bartoszewicz
// Rozliczenia z osobami piszącymi: stawki, premie, szkic protokołów dla zarządu i wysyłka PDF do osób w wiadomościach prywatnych.
// Stawki i kwoty widzi tylko zarząd (FINANCE_USER_IDS): trafiają wyłącznie do wiadomości prywatnych i odpowiedzi widocznych tylko dla niego,
// nigdy na karty zadań, tablicę, stronę z tablicą ani kanały.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, DiscordAPIError,
} = require('discord.js');
const B = require('./board');
const F = require('./finance');
const { renderProtocol } = require('./protocol');

const NO_MENTIONS = { parse: [] };
const FIN_ONLY_MSG = 'Rozliczenia są tylko dla zarządu.';
const DISABLED_MSG = 'Rozliczenia są wyłączone. Osoba, która obsługuje bota, ustawia je zmienną FINANCE_USER_IDS (numery osób z zarządu, oddzielone przecinkami).';
const STALE_MSG = 'Ten szkic jest nieaktualny: został już zatwierdzony, pominięty albo zastąpiony nowszym.';
const DM_CLOSED_CODE = 50007;
const MAX_DM_FILES = 10; // tyle załączników mieści jedna wiadomość
const MAX_UNDATED_OPTIONS = 25; // tyle opcji mieści jedno menu
const MAX_CONTENT = 1900;
const RETRY_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const REMOVE_WORDS = /^(brak|usun|usuń|-|0|0[.,]0{1,2})$/i;

const plural = (n, one, few, many) => {
  const a = n % 100;
  const b = n % 10;
  if (n === 1) return one;
  return b >= 2 && b <= 4 && !(a >= 12 && a <= 14) ? few : many;
};
const nTexts = (n) => `${n} ${plural(n, 'tekst', 'teksty', 'tekstów')}`;
const nBonuses = (n) => `${n} ${plural(n, 'premia', 'premie', 'premii')}`;
const clip = (text, max = MAX_CONTENT) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function createSettlements({
  client, config, store, now, log, UserError, today, collectBoard, metaOf, patchMeta, withLock, onTask, resolveTask,
}) {
  const cfg = config.finance;
  const enabled = cfg.userIds.length > 0;
  const isFinance = (userId) => cfg.userIds.includes(String(userId));
  let busy = false;
  let seq = 0;
  const attempts = new Map(); // klucz protokołu -> {n, at}: tylko w pamięci, po restarcie liczymy od nowa

  // ------------------------------------------------------------ stan: top-level `fin`
  // { start: 'RRRR-MM', rates: {userId: {name, rate}}, months: {klucz: rekord} }, klucz = miesiąc albo „miesiąc#2” dla uzupełnienia.
  // rekord: {month, round, state: draft|sent|skipped, preparedAt, report, sig, note, drafts: [{userId, channelId, messageId}],
  //          sentAt, sentBy, delivery: {userId: {ok, at, code?}}}
  const getFin = () => store.get('fin') || {};
  const setFin = (patch) => store.set('fin', { ...getFin(), ...patch });
  const ratesOf = () => getFin().rates || {};
  const recordsOf = () => getFin().months || {};
  const putRecord = (key, rec) => setFin({ months: { ...recordsOf(), [key]: rec } });
  const keyFor = (month, round) => (round > 1 ? `${month}#${round}` : month);

  function latestRecord(month) {
    let best = null;
    for (const [key, rec] of Object.entries(recordsOf())) {
      if (rec.month === month && (!best || rec.round > best.rec.round)) best = { key, rec };
    }
    return best;
  }

  // Miesiące, których ostatni protokół jest już wysłany albo pominięty: premie do nich dopisujemy w bieżącym miesiącu.
  function closedMonths() {
    const out = {};
    for (const rec of Object.values(recordsOf())) {
      if (rec.state === 'draft') continue;
      const latest = latestRecord(rec.month);
      if (latest && latest.rec.state !== 'draft') out[rec.month] = true;
    }
    return out;
  }

  const sameDraftUser = (rec, userId) => (rec.drafts || []).find((d) => d.userId === userId);
  const newBonusId = () => { seq += 1; return `${now().getTime().toString(36)}${seq.toString(36)}`; };
  const assertEnabled = () => { if (!enabled) throw new UserError(DISABLED_MSG); };
  const assertFinance = (userId) => { assertEnabled(); if (!isFinance(userId)) throw new UserError(FIN_ONLY_MSG, undefined, 403); };

  // ------------------------------------------------------------ data oddania tekstu do redakcji
  // Zapisujemy ją przy przejściu do „Do redakcji” (lub dalej) i kasujemy przy powrocie do pisania, o ile tekst nie jest jeszcze rozliczony.
  // Wywoływane po zmianie statusu z karty, strony i ręcznej zmianie tagu w Discordzie; powtórne wywołanie niczego nie psuje.
  function noteStatusChange(threadId, before, after) {
    const wasDone = B.isWritingDone(before);
    const isDone = B.isWritingDone(after);
    if (wasDone === isDone) return;
    const m = metaOf(threadId) || {};
    if (m.s) return;
    if (isDone) patchMeta(threadId, { h: today() });
    else if (m.h) patchMeta(threadId, { h: null });
  }

  // ------------------------------------------------------------ zestawienie z aktualnych zadań
  async function gatherTasks() {
    const { tasks, partial, note } = await collectBoard();
    const out = tasks.map((t) => {
      const m = metaOf(t.id) || {};
      const ts = t.thread && t.thread.createdTimestamp;
      return {
        id: t.id,
        name: t.name,
        url: t.url,
        status: t.status,
        assigneeId: t.assigneeId,
        handedIn: m.h || null,
        settled: m.s || null,
        archived: Boolean(t.thread && t.thread.archived),
        created: ts ? B.todayIn(config.timeZone, new Date(ts)) : null,
        bonuses: Array.isArray(m.b) ? m.b : [],
      };
    });
    return { tasks: out, note: partial ? (note || 'Nie udało się pobrać części zadań.') : '' };
  }

  async function buildFor(month) {
    const { tasks, note } = await gatherTasks();
    const report = F.buildReport({ month, tasks, people: ratesOf() });
    return { report, sig: F.reportSignature(report), note };
  }

  const hasLeftovers = (r) => r.noRate.length > 0 || r.unassigned.length > 0 || r.undated.length > 0;

  // ------------------------------------------------------------ treść i przyciski szkicu
  // Lista z ograniczeniem długości: pierwsze `max` pozycji i „i N więcej”.
  const capped = (items, max, more = 'więcej') => (items.length > max ? `${items.slice(0, max).join(', ')} i ${items.length - max} ${more}` : items.join(', '));

  // Treść szkicu mieści się w jednej wiadomości (limit Discorda 2000 znaków): ostrzeżenia mają pierwszeństwo przed długą listą osób.
  function draftContent(rec) {
    const r = rec.report;
    const head = [`**Rozliczenie za ${r.label}${rec.round > 1 ? ` (uzupełnienie ${rec.round - 1})` : ''}: szkic do zatwierdzenia**`];
    if (!r.persons.length) head.push('Nie ma jeszcze nic do rozliczenia z kompletnymi danymi (patrz uwagi niżej).');
    const personLines = r.persons.map((p) => {
      const parts = [nTexts(p.texts.length)];
      if (p.bonuses.length) parts.push(nBonuses(p.bonuses.length));
      return `• ${B.esc(p.name)} (<@${p.userId}>): ${parts.join(', ')}, razem ${F.formatMoney(p.total)}`;
    });
    const totalLine = r.persons.length ? `**Razem do wypłaty: ${F.formatMoney(r.grandTotal)}** (${r.persons.length} ${plural(r.persons.length, 'osoba', 'osoby', 'osób')})` : null;
    const notes = [];
    if (r.noRate.length) {
      const who = r.noRate.map((x) => `<@${x.userId}> (${nTexts(x.texts)}${x.bonuses ? `, ${nBonuses(x.bonuses)}` : ''})`);
      notes.push(`Bez stawki, więc bez protokołu: ${capped(who, 8, 'osób')}. Ustaw: /rozliczenia stawka.`);
    }
    if (r.unassigned.length) {
      const shown = r.unassigned.slice(0, 5).map((x) => `„${B.esc(x.title)}” (${x.kind})`).join(', ');
      notes.push(`Bez osoby (nie wejdą do protokołów): ${shown}${r.unassigned.length > 5 ? ` i ${r.unassigned.length - 5} więcej` : ''}. Przydziel osobę na karcie i odśwież szkic.`);
    }
    if (r.undated.length) {
      notes.push(`Bez daty oddania (tekst z czasów przed rozliczeniami): ${r.undated.length}. Zaznacz w menu niżej te, które oddano w tym miesiącu.`);
    }
    if (rec.note) notes.push(`${rec.note} Zestawienie może być niepełne, odśwież szkic.`);
    const tail = [
      ...(notes.length ? ['', ...notes.map((n) => `Uwaga: ${n}`)] : []),
      '',
      r.persons.length
        ? 'Po zatwierdzeniu bot wyśle każdej osobie jej protokół (PDF) w wiadomości prywatnej. Dane zostają wtedy zamrożone.'
        : 'Nie ma kogo jeszcze rozliczyć.',
    ];
    // Osoby dopisujemy, dopóki mieści się budżet; reszta idzie do „i N więcej” (pełne zestawienie jest w PDF-ach nad szkicem).
    const fixed = [...head, ...(totalLine ? [totalLine] : []), ...tail].join('\n').length + 60;
    const shown = [];
    let used = fixed;
    for (const line of personLines) {
      if (used + line.length + 1 > MAX_CONTENT) break;
      shown.push(line);
      used += line.length + 1;
    }
    if (shown.length < personLines.length) shown.push(`…i ${personLines.length - shown.length} ${plural(personLines.length - shown.length, 'osoba', 'osoby', 'osób')} więcej (patrz PDF-y wyżej)`);
    return clip([...head, ...shown, ...(totalLine ? [totalLine] : []), ...tail].join('\n'));
  }

  function draftComponents(key, rec) {
    const r = rec.report;
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`kb:fin:send:${key}`).setLabel(`Wyślij do osób (${r.persons.length})`).setStyle(ButtonStyle.Success).setDisabled(r.persons.length === 0),
      new ButtonBuilder().setCustomId(`kb:fin:refresh:${key}`).setLabel('Odśwież szkic').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kb:fin:skip:${key}`).setLabel('Pomiń ten miesiąc').setStyle(ButtonStyle.Secondary),
    )];
    const candidates = r.undated.slice(0, MAX_UNDATED_OPTIONS);
    if (candidates.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`kb:fin:dated:${key}`)
          .setPlaceholder(`Zaznacz teksty oddane w: ${r.label}`)
          .setMinValues(1)
          .setMaxValues(candidates.length)
          .addOptions(candidates.map((u) => ({
            label: Array.from(u.title).slice(0, 100).join(''),
            value: u.id,
            description: clip(`${u.status}${u.created ? `, założono ${B.fmtDate(u.created)}` : ''}${u.archived ? ', zarchiwizowany' : ''}`, 100),
          }))),
      ));
    }
    return rows;
  }

  const draftPayload = (key, rec) => ({ content: draftContent(rec), components: draftComponents(key, rec), allowedMentions: NO_MENTIONS });

  function confirmPayload(key, rec) {
    const r = rec.report;
    const left = [];
    if (r.noRate.length) left.push(`bez stawki: ${r.noRate.reduce((s, x) => s + x.texts + x.bonuses, 0)}`);
    if (r.unassigned.length) left.push(`bez osoby: ${r.unassigned.length}`);
    if (r.undated.length) left.push(`bez daty oddania: ${r.undated.length}`);
    const lines = [
      `**Wysłać protokoły za ${r.label} do ${r.persons.length} ${plural(r.persons.length, 'osoby', 'osób', 'osób')}?** Razem ${F.formatMoney(r.grandTotal)}.`,
      'Tej operacji nie da się cofnąć: dane zostaną zamrożone, a osoby dostaną PDF w wiadomości prywatnej.',
    ];
    if (left.length) lines.push(`Poza protokołami zostają teksty i premie: ${left.join(', ')}. Rozliczysz je później protokołem uzupełniającym (/rozliczenia szkic).`);
    return {
      content: clip(lines.join('\n')),
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`kb:fin:yes:${key}`).setLabel('Tak, wyślij').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`kb:fin:back:${key}`).setLabel('Wróć do szkicu').setStyle(ButtonStyle.Secondary),
      )],
      allowedMentions: NO_MENTIONS,
    };
  }

  const dmReason = (d) => (d.code === DM_CLOSED_CODE ? 'ma wyłączone wiadomości prywatne od członków serwera' : 'nie udało się wysłać');

  function finalPayload(key, rec) {
    const r = rec.report;
    const failed = r.persons.filter((p) => !(rec.delivery && rec.delivery[p.userId] && rec.delivery[p.userId].ok));
    const ok = r.persons.length - failed.length;
    const lines = [`**Protokoły za ${r.label}${rec.round > 1 ? ` (uzupełnienie ${rec.round - 1})` : ''}: dostarczono ${ok} z ${r.persons.length}.**`];
    if (failed.length) {
      lines.push(...failed.map((p) => `• ${B.esc(p.name)} (<@${p.userId}>): ${dmReason((rec.delivery || {})[p.userId] || {})}`));
      lines.push('Poproś te osoby o włączenie wiadomości prywatnych od członków serwera i ponów wysyłkę przyciskiem. PDF możesz też przesłać im sam, plik masz w szkicu powyżej.');
    } else {
      lines.push('Każda osoba dostała swój protokół z prośbą o sprawdzenie, dopisanie godzin, podpis i odesłanie e-mailem.');
    }
    const components = failed.length
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`kb:fin:retry:${key}`).setLabel(`Ponów wysyłkę (${failed.length})`).setStyle(ButtonStyle.Primary))]
      : [];
    return { content: clip(lines.join('\n')), components, allowedMentions: NO_MENTIONS };
  }

  // ------------------------------------------------------------ PDF i wiadomości prywatne
  async function protocolFiles(rec, persons = rec.report.persons) {
    const used = new Set();
    const files = new Map();
    for (const p of persons) {
      const base = `protokol-${rec.month}-${F.safeFileName(p.name)}`;
      let name = base;
      for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
      used.add(name);
      const buf = await renderProtocol({
        month: rec.month, issuer: cfg.issuer, returnEmail: cfg.returnEmail, title: cfg.title, supplement: rec.round > 1, preparedAt: rec.preparedAt, person: p,
      });
      files.set(p.userId, { attachment: buf, name: `${name}.pdf` });
    }
    return files;
  }

  function personText(rec, person, approverId) {
    const lines = [
      `Cześć! W załączniku protokół rozliczenia za ${rec.report.label} (${cfg.issuer}).`,
      'Proszę: sprawdź zestawienie tekstów i kwot, dopisz liczbę przepracowanych godzin, podpisz i odeślij'
        + (cfg.returnEmail ? ` na adres ${cfg.returnEmail}.` : ' do redakcji.'),
      `Razem do wypłaty: ${F.formatMoney(person.total)}.`,
      `Jeśli coś się nie zgadza, napisz do <@${approverId}> przed podpisaniem.`,
    ];
    return lines.join('\n');
  }

  const codeOf = (err) => (err instanceof DiscordAPIError ? err.code : undefined);

  async function editMessage(ref, payload) {
    const channel = await client.channels.fetch(ref.channelId);
    await channel.messages.edit(ref.messageId, payload);
  }

  // Szkic do zarządu: najpierw podgląd PDF-ów, na końcu podsumowanie z przyciskami (żeby decyzja była na dole rozmowy).
  async function deliverDraft(key, rec, userIds, { exceptMessageId = null } = {}) {
    const files = await protocolFiles(rec);
    const ok = [];
    const failed = [];
    for (const userId of userIds) {
      try {
        const user = await client.users.fetch(userId);
        const list = [...files.values()];
        for (let i = 0; i < list.length; i += MAX_DM_FILES) {
          await user.send({ content: i === 0 ? `Podgląd protokołów za ${rec.report.label} (tak będą wyglądały):` : undefined, files: list.slice(i, i + MAX_DM_FILES), allowedMentions: NO_MENTIONS });
        }
        const msg = await user.send(draftPayload(key, rec));
        const old = sameDraftUser(rec, userId);
        rec = { ...rec, drafts: [...(rec.drafts || []).filter((d) => d.userId !== userId), { userId, channelId: msg.channelId, messageId: msg.id }] };
        putRecord(key, rec);
        if (old && old.messageId !== exceptMessageId) {
          await editMessage(old, { content: 'Zastąpiony nowszym szkicem (poniżej w rozmowie).', components: [], allowedMentions: NO_MENTIONS }).catch(() => {});
        }
        ok.push(userId);
      } catch (err) {
        failed.push({ userId, code: codeOf(err), message: err.message });
        log.warn(`Rozliczenia: nie udało się wysłać szkicu do ${userId}: ${err.message}`);
      }
    }
    return { rec, ok, failed };
  }

  async function sendProtocols(key, rec, onlyUserIds = null) {
    const targets = rec.report.persons.filter((p) => !onlyUserIds || onlyUserIds.includes(p.userId));
    const files = await protocolFiles(rec, targets);
    for (const p of targets) {
      let entry;
      try {
        const user = await client.users.fetch(p.userId);
        await user.send({ content: personText(rec, p, rec.sentBy), files: [files.get(p.userId)], allowedMentions: NO_MENTIONS });
        entry = { ok: true, at: now().toISOString() };
      } catch (err) {
        entry = { ok: false, at: now().toISOString(), code: codeOf(err) };
        log.warn(`Rozliczenia: nie udało się wysłać protokołu do ${p.userId}: ${err.message}`);
      }
      rec = { ...rec, delivery: { ...(rec.delivery || {}), [p.userId]: entry } };
      putRecord(key, rec);
    }
    return rec;
  }

  // Po zatwierdzeniu: teksty i premie z protokołu dostają miesiąc rozliczenia i nie wejdą do żadnego następnego.
  function settleItems(rec) {
    for (const id of rec.report.settle.texts) if (metaOf(id)) patchMeta(id, { s: rec.month });
    const byTask = new Map();
    for (const { id, bid } of rec.report.settle.bonuses) byTask.set(id, [...(byTask.get(id) || []), bid]);
    for (const [id, bids] of byTask) {
      const m = metaOf(id);
      if (!m || !Array.isArray(m.b)) continue;
      patchMeta(id, { b: m.b.map((b) => (bids.includes(b.i) ? { ...b, s: rec.month } : b)) });
    }
  }

  // ------------------------------------------------------------ przygotowanie szkicu
  // Nowy protokół dla miesiąca: pierwszy, albo uzupełniający, gdy poprzedni został wysłany lub pominięty. Zwraca null, gdy nie ma co rozliczać.
  async function prepareRecord(month) {
    const latest = latestRecord(month);
    const round = latest ? (latest.rec.state === 'draft' ? latest.rec.round : latest.rec.round + 1) : 1;
    const key = keyFor(month, round);
    const { report, sig, note } = await buildFor(month);
    if (!report.persons.length && !hasLeftovers(report)) return { key, rec: null }; // nic do rozliczenia, nic do uzupełnienia
    const prev = latest && latest.rec.state === 'draft' ? latest.rec : null;
    const rec = {
      month, round, state: 'draft', preparedAt: today(), report, sig, note, drafts: prev ? prev.drafts : [], delivery: {},
    };
    putRecord(key, rec);
    return { key, rec };
  }

  const retryOk = (key) => {
    const a = attempts.get(key);
    return !a || (a.n < MAX_ATTEMPTS && now().getTime() >= a.at);
  };
  const noteFailure = (key) => {
    const a = attempts.get(key) || { n: 0, at: 0 };
    attempts.set(key, { n: a.n + 1, at: now().getTime() + RETRY_MS });
  };

  // Automat: pierwszego dnia roboczego miesiąca, od godziny podsumowania, przygotowuje szkic za poprzedni miesiąc i wysyła go zarządowi.
  async function financeTick() {
    if (!enabled || busy) return;
    busy = true;
    try {
      const t = now();
      const day = today();
      if (!getFin().start) {
        setFin({ start: F.monthOf(day) });
        log.log(`Rozliczenia włączone: pierwszy protokół powstanie za miesiąc ${F.monthLabel(F.monthOf(day))}, na początku następnego.`);
      }
      if (B.clockIn(config.timeZone, t).hour < config.digestHour) return;
      const fin = getFin();
      const prepared = {};
      for (const r of Object.values(recordsOf())) prepared[r.month] = true;
      const month = F.monthToPrepare({ todayIso: day, start: fin.start, prepared });
      if (month && retryOk(month)) {
        try {
          await withLock(`fin:${month}`, async () => {
            if (latestRecord(month)) return;
            const made = await prepareRecord(month);
            if (!made.rec) {
              putRecord(month, {
                month, round: 1, state: 'skipped', preparedAt: day, report: null, sig: '', note: '', drafts: [], delivery: {}, reason: 'empty',
              });
              log.log(`Rozliczenia za ${F.monthLabel(month)}: nic do rozliczenia, pomijam.`);
              return;
            }
            const res = await deliverDraft(made.key, made.rec, cfg.userIds);
            if (res.ok.length) log.log(`Rozliczenia za ${F.monthLabel(month)}: szkic wysłany do ${res.ok.length} ${plural(res.ok.length, 'osoby', 'osób', 'osób')} z zarządu.`);
            else { noteFailure(month); log.error(`Rozliczenia za ${F.monthLabel(month)}: nikt z zarządu nie dostał szkicu (wiadomości prywatne wyłączone?). Spróbuję ponownie za pół godziny albo użyj /rozliczenia szkic.`); }
          });
          attempts.delete(month);
        } catch (err) {
          noteFailure(month);
          log.error(`Rozliczenia za ${F.monthLabel(month)}: przygotowanie nie wyszło (${err.detail || err.message}). Spróbuję ponownie za pół godziny.`);
        }
      }
      // Szkic, który nie dotarł do nikogo, ponawiamy.
      for (const [key, rec] of Object.entries(recordsOf())) {
        if (rec.state !== 'draft' || (rec.drafts || []).length || !retryOk(key)) continue;
        const res = await deliverDraft(key, rec, cfg.userIds);
        if (res.ok.length) attempts.delete(key); else noteFailure(key);
      }
    } catch (err) {
      log.error(`Rozliczenia: ${err.detail || err.stack || err.message}`);
    } finally {
      busy = false;
    }
  }

  // ------------------------------------------------------------ komenda /rozliczenia
  async function cmdStawka(interaction) {
    const user = interaction.options.getUser('osoba', true);
    if (user.bot) throw new UserError('Stawkę można ustawić tylko osobie, nie botowi.');
    const raw = interaction.options.getString('kwota', true).trim();
    const nameOpt = (interaction.options.getString('imie') || '').trim();
    const rates = { ...ratesOf() };
    if (REMOVE_WORDS.test(raw)) {
      if (!rates[user.id]) throw new UserError('Ta osoba nie ma ustawionej stawki.');
      delete rates[user.id];
      setFin({ rates });
      await interaction.editReply({ content: `Usunięto stawkę osoby <@${user.id}>. Jej teksty nie wejdą do protokołów, dopóki nie ustawisz nowej.`, allowedMentions: NO_MENTIONS });
      return;
    }
    const rate = F.parseMoney(raw);
    if (!rate) throw new UserError('Nie rozumiem kwoty. Wpisz stawkę za jeden tekst, np. 120 albo 120,50 (albo „brak”, żeby ją usunąć).');
    const member = interaction.options.getMember ? interaction.options.getMember('osoba') : null;
    const name = nameOpt || (rates[user.id] && rates[user.id].name) || (member && member.displayName) || user.globalName || user.username;
    rates[user.id] = { name: Array.from(name).slice(0, 80).join(''), rate };
    setFin({ rates });
    await interaction.editReply({
      content: `Zapisano: <@${user.id}> jako „${B.esc(rates[user.id].name)}”, ${F.formatMoney(rate)} za tekst. To imię i nazwisko pojawi się w protokole (zmienisz je opcją „imie”). Stawkę widzi tylko zarząd.`,
      allowedMentions: NO_MENTIONS,
    });
  }

  async function cmdStawki(interaction) {
    const entries = Object.entries(ratesOf()).sort((a, b) => a[1].name.localeCompare(b[1].name, 'pl'));
    if (!entries.length) {
      await interaction.editReply({ content: 'Nikt nie ma jeszcze stawki. Ustaw ją komendą /rozliczenia stawka.' });
      return;
    }
    const lines = entries.map(([id, r]) => `• ${B.esc(r.name)} (<@${id}>): ${F.formatMoney(r.rate)} za tekst`);
    await interaction.editReply({ content: clip(`**Stawki za tekst** (widzi je tylko zarząd):\n${lines.join('\n')}`), allowedMentions: NO_MENTIONS });
  }

  async function cmdPremia(interaction) {
    const raw = interaction.options.getString('kwota', true).trim();
    const note = Array.from((interaction.options.getString('opis') || '').trim()).slice(0, 80).join('');
    const remove = REMOVE_WORDS.test(raw);
    const amount = remove ? 0 : F.parseMoney(raw);
    if (!remove && !amount) throw new UserError('Nie rozumiem kwoty premii. Wpisz np. 20 albo 20,50 (albo „brak”, żeby usunąć nierozliczone premie tego tekstu).');
    let reply = '';
    await onTask(interaction, async ({ thread, st }) => {
      const m = metaOf(thread.id) || {};
      const list = Array.isArray(m.b) ? m.b.slice() : [];
      if (remove) {
        const kept = list.filter((b) => b.s);
        if (kept.length === list.length) throw new UserError('Ten tekst nie ma nierozliczonych premii do usunięcia.');
        patchMeta(thread.id, { b: kept });
        reply = `Usunięto ${nBonuses(list.length - kept.length)} z tego tekstu (rozliczone zostają bez zmian).`;
        return;
      }
      const cur = await resolveTask(thread, st, today());
      const month = F.bonusMonthFor({ handedIn: m.h || null, start: getFin().start || null, closed: closedMonths(), currentMonth: F.monthOf(today()) });
      list.push({ i: newBonusId(), a: amount, n: note, m: month });
      patchMeta(thread.id, { b: list });
      const parts = [`Dodano premię ${F.formatMoney(amount)}${note ? ` (${B.esc(note)})` : ''}. Trafi do rozliczenia za ${F.monthLabel(month)}.`];
      if (!cur.assigneeId) parts.push('Uwaga: to zadanie nie ma osoby, więc premia nie wejdzie do protokołu, dopóki ktoś nie zostanie przypisany.');
      else if (!(ratesOf()[cur.assigneeId] && ratesOf()[cur.assigneeId].rate > 0)) parts.push(`Uwaga: <@${cur.assigneeId}> nie ma ustawionej stawki, więc nie dostanie protokołu (ustaw: /rozliczenia stawka).`);
      const rec = latestRecord(month);
      if (rec && rec.rec.state === 'draft') parts.push('Szkic tego miesiąca już istnieje: odśwież go przyciskiem przed zatwierdzeniem.');
      reply = parts.join(' ');
    });
    await interaction.editReply({ content: reply, allowedMentions: NO_MENTIONS });
  }

  async function cmdSzkic(interaction) {
    const current = F.monthOf(today());
    const month = F.normalizeMonth(interaction.options.getString('miesiac'), F.prevMonth(current));
    if (!month) throw new UserError('Nie rozumiem miesiąca. Wpisz np. 2026-10 albo 10.2026 (puste pole = poprzedni miesiąc).');
    if (month >= current) throw new UserError('Rozliczać można tylko zakończone miesiące. Za bieżący protokół powstanie na początku następnego.');
    await withLock(`fin:${month}`, async () => {
      const made = await prepareRecord(month);
      if (!made.rec) throw new UserError(`Za ${F.monthLabel(month)} nie ma nic nowego do rozliczenia (ani tekstów oddanych w tym miesiącu, ani premii).`);
      const res = await deliverDraft(made.key, made.rec, [interaction.user.id]);
      if (!res.ok.length) {
        throw new UserError(res.failed[0] && res.failed[0].code === DM_CLOSED_CODE
          ? 'Nie mogę wysłać Ci wiadomości prywatnej. Włącz w Discordzie (ustawienia serwera, Prywatność) wiadomości prywatne od członków serwera i spróbuj jeszcze raz.'
          : 'Nie udało się wysłać szkicu w wiadomości prywatnej. Spróbuj za chwilę.');
      }
      await interaction.editReply({ content: `Szkic rozliczenia za ${F.monthLabel(month)} wysłałem Ci w wiadomości prywatnej. Tam go sprawdzisz i zatwierdzisz.`, allowedMentions: NO_MENTIONS });
    });
  }

  async function command(interaction) {
    assertFinance(interaction.user.id);
    const sub = interaction.options.getSubcommand();
    if (sub === 'stawka') return cmdStawka(interaction);
    if (sub === 'stawki') return cmdStawki(interaction);
    if (sub === 'premia') return cmdPremia(interaction);
    if (sub === 'szkic') return cmdSzkic(interaction);
    throw new UserError('Nie znam tej komendy. Odśwież Discorda (Ctrl+R) i spróbuj ponownie.');
  }

  // ------------------------------------------------------------ przyciski i menu w wiadomościach prywatnych
  function draftOf(key) {
    const rec = recordsOf()[key];
    if (!rec || rec.state !== 'draft') throw new UserError(STALE_MSG);
    return rec;
  }

  async function refreshFor(interaction, key, rec) {
    const fresh = await buildFor(rec.month);
    const next = { ...rec, report: fresh.report, sig: fresh.sig, note: fresh.note, preparedAt: today() };
    putRecord(key, next);
    await interaction.editReply({ content: 'Zastąpiony nowszym szkicem (poniżej w rozmowie).', components: [], allowedMentions: NO_MENTIONS });
    const res = await deliverDraft(key, next, [interaction.user.id], { exceptMessageId: interaction.message && interaction.message.id });
    if (!res.ok.length) throw new UserError('Nie udało się wysłać nowego szkicu. Spróbuj jeszcze raz.');
  }

  async function onComponent(interaction) {
    assertFinance(interaction.user.id);
    const [, , action, key = ''] = interaction.customId.split(':');
    await withLock(`fin:${key.split('#')[0]}`, async () => {
      if (action === 'retry') {
        const rec = recordsOf()[key];
        if (!rec || rec.state !== 'sent') throw new UserError(STALE_MSG);
        const pending = rec.report.persons.filter((p) => !(rec.delivery[p.userId] && rec.delivery[p.userId].ok)).map((p) => p.userId);
        const after = pending.length ? await sendProtocols(key, rec, pending) : rec;
        await interaction.editReply(finalPayload(key, after));
        return;
      }
      const rec = draftOf(key);
      if (action === 'send') { await interaction.editReply(confirmPayload(key, rec)); return; }
      if (action === 'back') { await interaction.editReply(draftPayload(key, rec)); return; }
      if (action === 'refresh') { await refreshFor(interaction, key, rec); return; }
      if (action === 'skip') {
        const next = { ...rec, state: 'skipped' };
        putRecord(key, next);
        const text = { content: `Pominięto rozliczenie za ${rec.report.label}${rec.round > 1 ? ` (uzupełnienie ${rec.round - 1})` : ''}. Możesz je przygotować później komendą /rozliczenia szkic.`, components: [], allowedMentions: NO_MENTIONS };
        await interaction.editReply(text);
        for (const d of next.drafts || []) if (!interaction.message || d.messageId !== interaction.message.id) await editMessage(d, text).catch(() => {});
        return;
      }
      if (action === 'dated') {
        const valid = new Set(rec.report.undated.map((u) => u.id));
        const stamp = F.lastDayOf(rec.month);
        for (const id of interaction.values || []) {
          const m = metaOf(id) || {}; // post założony ręcznie i nigdy nietknięty botem nie ma jeszcze żadnych danych
          if (valid.has(id) && !m.h && !m.s) patchMeta(id, { h: stamp });
        }
        await refreshFor(interaction, key, rec);
        return;
      }
      if (action === 'yes') { await approve(interaction, key, rec); return; }
      throw new UserError('Nie znam tego przycisku. Zamknij tę rozmowę i poproś o nowy szkic: /rozliczenia szkic.');
    });
  }

  // Zatwierdzenie: najpierw sprawdzamy, czy dane nie zmieniły się od szkicu (nowy tekst, premia, stawka, zmiana tagu), bo zatwierdzamy to,
  // co zarząd widział. Jeśli się zmieniły, pokazujemy nowy szkic i nic nie wysyłamy.
  async function approve(interaction, key, rec) {
    const fresh = await buildFor(rec.month);
    if (fresh.sig !== rec.sig) {
      const next = { ...rec, report: fresh.report, sig: fresh.sig, note: fresh.note, preparedAt: today() };
      putRecord(key, next);
      await interaction.editReply({ content: 'Zastąpiony nowszym szkicem (poniżej w rozmowie).', components: [], allowedMentions: NO_MENTIONS });
      await deliverDraft(key, next, [interaction.user.id], { exceptMessageId: interaction.message && interaction.message.id });
      throw new UserError('Dane zmieniły się od czasu szkicu (nowy tekst, premia, stawka albo status), więc nic nie wysłałem. Sprawdź nowy szkic i zatwierdź go jeszcze raz.');
    }
    let sent = {
      ...rec, state: 'sent', sentAt: now().toISOString(), sentBy: interaction.user.id, delivery: {},
    };
    putRecord(key, sent);
    settleItems(sent);
    // Komunikaty o postępie nie mogą przerwać wysyłki: dane są już zamrożone, więc protokoły muszą wyjść mimo chwilowego błędu Discorda.
    await interaction.editReply({ content: `Wysyłam protokoły za ${rec.report.label}…`, components: [], allowedMentions: NO_MENTIONS }).catch((err) => log.warn(`Rozliczenia: ${err.message}`));
    sent = await sendProtocols(key, sent);
    await interaction.editReply(finalPayload(key, sent)).catch((err) => log.warn(`Rozliczenia: nie udało się pokazać wyniku wysyłki (${err.message}); stan zapisano.`));
    const done = { content: `Protokoły za ${sent.report.label} zatwierdził(a) <@${interaction.user.id}> i wysłał(a) do osób.`, components: [], allowedMentions: NO_MENTIONS };
    for (const d of sent.drafts || []) if (!interaction.message || d.messageId !== interaction.message.id) await editMessage(d, done).catch(() => {});
    log.log(`Rozliczenia za ${F.monthLabel(sent.month)}: wysłano ${sent.report.persons.length} ${plural(sent.report.persons.length, 'protokół', 'protokoły', 'protokołów')}.`);
  }

  return {
    enabled, isFinance, command, onComponent, financeTick, noteStatusChange,
  };
}

module.exports = { createSettlements, plural };
