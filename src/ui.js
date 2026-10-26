'use strict';
// Autor: Mateusz Bartoszewicz
// Elementy interfejsu Discorda: karta zadania w poście, nagłówek żywej tablicy, formularze (modale).
const {
  ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const B = require('./board');

const NO_MENTIONS = { parse: [] };

// Premia za social: przyciski niosą docelową akcję, więc podwójne kliknięcie nic nie psuje. Zgłasza osoba z zadania (albo zarząd, wtedy od razu zatwierdza),
// zatwierdza zarząd, cofa osoba (zgłoszenie) albo zarząd (też zatwierdzoną); reguły sprawdza moduł rozliczeń przy kliknięciu, a nie karta.
const SOCIAL_FIELD = { claimed: 'zgłoszona, czeka na zatwierdzenie', ok: '✓ zatwierdzona', settled: '✓ rozliczona' };
function socialButtons(social) {
  const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (social === 'claimed') return [btn('kb:social:off', 'Social: cofnij zgłoszenie'), btn('kb:social:ok', 'Zatwierdź social', ButtonStyle.Success)];
  if (social === 'ok') return [btn('kb:social:off', 'Social ✓ (usuń premię)')];
  if (social === 'settled') return [btn('kb:social:off', 'Social ✓ (rozliczone)').setDisabled(true)];
  return [btn('kb:social:on', 'Premia za social')];
}

// Karta zadania: wiadomość bota w poście z podglądem (osoba, termin, priorytet) i przyciskami.
// task: {status, assigneeId, due (oddanie tekstu), pubDue (publikacja), urgent, social}
// social: null (rozliczenia wyłączone: karta bez premii) albo none, claimed (zgłoszona), ok (zatwierdzona), settled (rozliczona); nigdy kwota
// Przyciski niosą w identyfikatorze docelową wartość (status, "pilne" włączone lub wyłączone, "weź" albo "zwolnij"),
// więc podwójne kliknięcie (np. na wolnym telefonie) nie przesuwa zadania dwa razy ani nie cofa własnej akcji.
function cardPayload(task) {
  const { status, assigneeId, due, pubDue, urgent, social = null } = task;
  const idx = B.STATUSES.indexOf(status);
  const first = idx <= 0;
  const last = idx >= B.STATUSES.length - 1;
  const select = new StringSelectMenuBuilder()
    .setCustomId('kb:status')
    .setPlaceholder('Zmień status')
    .addOptions(B.STATUSES.map((s) => ({ label: s, value: s, default: s === status })));
  const buttons = [
    new ButtonBuilder().setCustomId(first ? 'kb:prev' : `kb:go:${B.STATUSES[idx - 1]}`).setLabel('◀ Wstecz').setStyle(ButtonStyle.Secondary).setDisabled(first),
    // Przejście do "Do redakcji" to oddanie tekstu: nazywamy je wprost, żeby autor wiedział, że kończy pisanie.
    new ButtonBuilder().setCustomId(last ? 'kb:next' : `kb:go:${B.STATUSES[idx + 1]}`)
      .setLabel(B.STATUSES[idx + 1] === 'Do redakcji' ? 'Oddaj do redakcji ▶' : 'Dalej ▶').setStyle(ButtonStyle.Primary).setDisabled(last),
    assigneeId
      ? new ButtonBuilder().setCustomId('kb:release').setLabel('Zwolnij').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId('kb:take').setLabel('Biorę to').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('kb:due').setLabel('Terminy').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(urgent ? 'kb:urgent:off' : 'kb:urgent:on').setLabel(urgent ? 'Zdejmij pilne' : 'Pilne')
      .setStyle(urgent ? ButtonStyle.Danger : ButtonStyle.Secondary),
  ];
  const assign = new UserSelectMenuBuilder().setCustomId('kb:assign').setPlaceholder('Przydziel osobę').setMinValues(1).setMaxValues(1);
  const fields = [
    { name: 'Osoba', value: assigneeId ? `<@${assigneeId}>` : 'brak, kliknij „Biorę to”', inline: true },
    { name: 'Oddanie tekstu', value: B.isWritingDone(status) ? (due ? `${B.fmtDate(due)} · tekst oddany` : 'tekst oddany') : (due ? B.fmtDate(due) : 'brak'), inline: true },
    { name: 'Publikacja', value: pubDue ? B.fmtDate(pubDue) : 'brak', inline: true },
    { name: 'Priorytet', value: urgent ? '🔥 pilne' : 'zwykły', inline: true },
  ];
  if (social && social !== 'none') fields.push({ name: 'Premia za social', value: SOCIAL_FIELD[social], inline: true });
  const rows = [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(...buttons),
    new ActionRowBuilder().addComponents(assign),
  ];
  if (social) rows.push(new ActionRowBuilder().addComponents(...socialButtons(social)));
  return {
    content: `Status: **${status}**`,
    embeds: [{ color: B.STATUS_COLORS[status], fields }],
    components: rows,
    allowedMentions: NO_MENTIONS,
  };
}

// Nagłówek żywej tablicy: podsumowanie, przycisk dodawania zadania i menu filtrów (odpowiedź prywatna).
// link: adres strony z tablicą (przeciąganie kart w przeglądarce), activity: przycisk uruchamiający ją w Discordzie.
function headerPayload(embed, { link = null, activity = false } = {}) {
  const filter = new StringSelectMenuBuilder()
    .setCustomId('kb:filter')
    .setPlaceholder('Pokaż mi…')
    .addOptions(Object.entries(B.FILTERS).map(([value, label]) => ({ label, value })));
  const buttons = [new ButtonBuilder().setCustomId('kb:new').setLabel('Dodaj zadanie').setStyle(ButtonStyle.Success)];
  if (activity) buttons.push(new ButtonBuilder().setCustomId('kb:activity').setLabel('Tablica z przeciąganiem').setStyle(ButtonStyle.Primary));
  if (link) buttons.push(new ButtonBuilder().setURL(link).setLabel(activity ? 'W przeglądarce' : 'Tablica z przeciąganiem').setStyle(ButtonStyle.Link));
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(...buttons),
      new ActionRowBuilder().addComponents(filter),
    ],
    allowedMentions: NO_MENTIONS,
  };
}

function textInput(id, { long = false, required = false, max, value, placeholder } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required);
  if (max) t.setMaxLength(max);
  if (value) t.setValue(value);
  if (placeholder) t.setPlaceholder(placeholder);
  return t;
}

// Formularz nowego zadania. Nowy typ okna (Label) pozwala wybrać osobę z listy; stary (legacy) ma tylko pola tekstowe.
function newTaskModal({ legacy = false } = {}) {
  const modal = new ModalBuilder().setCustomId('kb:newmodal').setTitle('Nowe zadanie');
  const title = textInput('title', { required: true, max: 100 });
  const due = textInput('due', { max: 10, placeholder: '05.11.2026, 2026-11-05 albo 05.11' });
  const pub = textInput('pubdue', { max: 10, placeholder: 'np. premiera gry: 12.11.2026' });
  const desc = textInput('desc', { long: true, max: 1500 });
  if (legacy) {
    const row = (label, input) => new ActionRowBuilder().addComponents(input.setLabel(label));
    return modal.addComponents(row('Tytuł', title), row('Oddanie tekstu (opcjonalnie)', due), row('Publikacja (opcjonalnie)', pub), row('Opis (opcjonalnie)', desc));
  }
  const person = new UserSelectMenuBuilder().setCustomId('person').setMinValues(0).setMaxValues(1).setRequired(false).setPlaceholder('Kto bierze to zadanie');
  return modal.addLabelComponents(
    new LabelBuilder().setLabel('Tytuł').setTextInputComponent(title),
    new LabelBuilder().setLabel('Osoba (opcjonalnie)').setUserSelectMenuComponent(person),
    new LabelBuilder().setLabel('Oddanie tekstu (opcjonalnie)').setTextInputComponent(due),
    new LabelBuilder().setLabel('Publikacja (opcjonalnie)').setTextInputComponent(pub),
    new LabelBuilder().setLabel('Opis (opcjonalnie)').setTextInputComponent(desc),
  );
}

// Okno zmiany terminów na karcie: oddanie tekstu i publikacja. Puste pole usuwa dany termin.
function dueModal({ due = null, pubDue = null } = {}, { legacy = false } = {}) {
  const modal = new ModalBuilder().setCustomId('kb:duemodal').setTitle('Terminy zadania');
  const holder = (id, value) => textInput(id, { max: 10, value: value ? B.fmtDate(value) : undefined, placeholder: '05.11.2026, 05.11 albo puste, żeby usunąć' });
  const write = holder('due', due);
  const publish = holder('pubdue', pubDue);
  if (legacy) {
    const row = (label, input) => new ActionRowBuilder().addComponents(input.setLabel(label));
    return modal.addComponents(row('Oddanie tekstu', write), row('Publikacja', publish));
  }
  return modal.addLabelComponents(
    new LabelBuilder().setLabel('Oddanie tekstu (puste = brak)').setTextInputComponent(write),
    new LabelBuilder().setLabel('Publikacja, np. premiera (puste = brak)').setTextInputComponent(publish),
  );
}

module.exports = { cardPayload, headerPayload, newTaskModal, dueModal };
