'use strict';
// Autor: Mateusz Bartoszewicz
const { SlashCommandBuilder, InteractionContextType } = require('discord.js');

function buildCommands() {
  const guildOnly = (b) => b.setContexts(InteractionContextType.Guild);
  return [
    guildOnly(new SlashCommandBuilder()
      .setName('tablica')
      .setDescription('Pokaż tablicę kanban z forum artykułów')
      .addBooleanOption((o) => o.setName('moje').setDescription('Tylko zadania przypisane do mnie'))
      .addBooleanOption((o) => o.setName('publicznie').setDescription('Wyślij na ten kanał, żeby widzieli ją wszyscy (tylko kanały redakcji; domyślnie widzisz tylko Ty)'))),
    guildOnly(new SlashCommandBuilder()
      .setName('zadanie')
      .setDescription('Dodaj zadanie jako nowy post na forum artykułów')
      .addStringOption((o) => o.setName('tytul').setDescription('Tytuł zadania lub artykułu').setRequired(true).setMaxLength(100))
      .addUserOption((o) => o.setName('osoba').setDescription('Kto jest odpowiedzialny'))
      .addStringOption((o) => o.setName('termin').setDescription('Termin oddania tekstu: 2026-11-05, 05.11.2026 lub 05.11').setMaxLength(10))
      .addStringOption((o) => o.setName('publikacja').setDescription('Termin publikacji (np. premiera): 2026-11-12, 12.11.2026 lub 12.11').setMaxLength(10))
      .addStringOption((o) => o.setName('opis').setDescription('Krótki opis, źródła, uwagi').setMaxLength(1500))),
    guildOnly(new SlashCommandBuilder()
      .setName('edytuj')
      .setDescription('Zmień terminy lub osobę w tym zadaniu (działa w każdym poście na forum zadań)')
      .addStringOption((o) => o.setName('termin').setDescription('Nowy termin oddania tekstu: 2026-11-05, 05.11.2026, 05.11 albo „brak”, żeby usunąć').setMaxLength(10))
      .addStringOption((o) => o.setName('publikacja').setDescription('Nowy termin publikacji: 2026-11-12, 12.11.2026, 12.11 albo „brak”, żeby usunąć').setMaxLength(10))
      .addUserOption((o) => o.setName('osoba').setDescription('Nowa osoba odpowiedzialna'))
      .addBooleanOption((o) => o.setName('zwolnij').setDescription('Zdejmij osobę z zadania (wróci do puli „Bez osoby”)'))),
    guildOnly(new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Dodaj kartę zadania z przyciskami do tego posta (zastępuje poprzednią)')),
    guildOnly(new SlashCommandBuilder()
      .setName('podsumowanie')
      .setDescription('Pokaż podsumowanie dnia (to samo, co bot wysyła rano)')),
    guildOnly(new SlashCommandBuilder()
      .setName('ustaw-tablice')
      .setDescription('Ustaw żywą tablicę kanban na tym kanale (tylko kierownictwo i moderacja)')),
    guildOnly(new SlashCommandBuilder()
      .setName('rozliczenia')
      .setDescription('Rozliczenia z osobami piszącymi: stawki, premie, protokoły (tylko zarząd)')
      .addSubcommand((c) => c
        .setName('stawka')
        .setDescription('Ustaw stawkę za jeden tekst dla osoby (widzi ją tylko zarząd)')
        .addUserOption((o) => o.setName('osoba').setDescription('Kto pisze').setRequired(true))
        .addStringOption((o) => o.setName('kwota').setDescription('Kwota za tekst tak, jak ma stać w protokole, np. 120 albo 120,50; „brak” usuwa stawkę').setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName('imie').setDescription('Imię i nazwisko do protokołu (domyślnie nazwa na serwerze)').setMaxLength(80)))
      .addSubcommand((c) => c
        .setName('stawki')
        .setDescription('Pokaż ustawione stawki (tylko Ty widzisz odpowiedź)'))
      .addSubcommand((c) => c
        .setName('premia')
        .setDescription('Dodaj premię do tego tekstu, np. za post na własnych social mediach (użyj w poście z zadaniem)')
        .addStringOption((o) => o.setName('kwota').setDescription('Kwota premii, np. 20 albo 20,50; „brak” usuwa nierozliczone premie tego tekstu').setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName('opis').setDescription('Za co, np. post na Facebooku').setMaxLength(80)))
      .addSubcommand((c) => c
        .setName('szkic')
        .setDescription('Przygotuj szkic protokołów za miesiąc i wyślij go do mnie w wiadomości prywatnej')
        .addStringOption((o) => o.setName('miesiac').setDescription('Miesiąc, np. 2026-10 albo 10.2026 (puste = poprzedni)').setMaxLength(10)))),
  ];
}

module.exports = { buildCommands };
