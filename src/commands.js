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
      .addStringOption((o) => o.setName('termin').setDescription('Termin: 2026-11-05, 05.11.2026 lub 05.11').setMaxLength(10))
      .addStringOption((o) => o.setName('opis').setDescription('Krótki opis, źródła, uwagi').setMaxLength(1500))),
    guildOnly(new SlashCommandBuilder()
      .setName('edytuj')
      .setDescription('Zmień termin lub osobę w tym zadaniu (działa w każdym poście na forum zadań)')
      .addStringOption((o) => o.setName('termin').setDescription('Nowy termin: 2026-11-05, 05.11.2026, 05.11 albo „brak”, żeby usunąć').setMaxLength(10))
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
  ];
}

module.exports = { buildCommands };
