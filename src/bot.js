'use strict';
// Autor: Mateusz Bartoszewicz
// Połączenie logiki kanbana z Discordem: komendy, karta zadania w poście, żywa tablica, podsumowanie dnia.
const {
  ChannelType, PermissionFlagsBits, MessageFlags, DiscordAPIError, EmbedBuilder,
} = require('discord.js');
const B = require('./board');
const { cardPayload, newTaskModal, dueModal } = require('./ui');
const { createLiveBoard } = require('./live');
const { createSettlements } = require('./settlements');

const EPHEMERAL = MessageFlags.Ephemeral;
const META_TTL_MS = 5 * 60 * 1000;
const ARCHIVE_PAGE = 100;
const ARCHIVE_MAX_PAGES = 5; // 500 zarchiwizowanych postów
const DIGEST_RETRY_MS = 10 * 60 * 1000;
const DIGEST_MAX_FAILURES = 4;
const NO_MENTIONS = { parse: [] };
const FORUM_ONLY_MSG = 'Ta komenda i ten panel działają tylko w postach na forum zadań.';
const NO_ACCESS_MSG = 'Ta funkcja jest tylko dla redakcji.';
const NO_PERMS_MSG = 'Bot nie ma wystarczających uprawnień na tym kanale lub forum (szczegóły w logu bota).';
const GENERIC_ERROR_MSG = 'Coś poszło nie tak. Spróbuj za chwilę, a jeśli się powtórzy, zgłoś to osobie, która obsługuje bota.';
const badDate = (what = 'terminu') => `Nie rozumiem ${what}. Użyj formatu 2026-11-05, 05.11.2026 albo 05.11.`;
const BAD_DATE_MSG = badDate();
const BAD_PUB_DATE_MSG = badDate('terminu publikacji');

const PERM_NAMES = new Map([
  [PermissionFlagsBits.ViewChannel, 'Wyświetlanie kanału'],
  [PermissionFlagsBits.SendMessages, 'Wysyłanie wiadomości'],
  [PermissionFlagsBits.SendMessagesInThreads, 'Wysyłanie wiadomości w wątkach'],
  [PermissionFlagsBits.ReadMessageHistory, 'Czytanie historii wiadomości'],
  [PermissionFlagsBits.ManageThreads, 'Zarządzanie wątkami'],
  [PermissionFlagsBits.EmbedLinks, 'Osadzanie linków'],
]);

// Komunikat, który wolno pokazać użytkownikowi. `detail` trafia tylko do logu.
class UserError extends Error {
  // status: kod HTTP dla strony z tablicą (domyślnie 400); Discord go nie używa.
  constructor(message, detail, status) { super(message); this.detail = detail; this.status = status; }
}
// Chwilowy problem (np. nie udało się pobrać części zadań): podsumowanie spróbuje ponownie.
class TransientError extends Error {}

const isMissingMessage = (err) => Boolean(err) && (err.code === 10008 || err.status === 404);
const isPermanentDiscordError = (err) => err instanceof DiscordAPIError && (err.status === 403 || err.status === 404);

function createBot({ client, config, store, now = () => new Date(), log = console }) {
  const metaCache = new Map();
  const locks = new Map();
  let digestBusy = false;
  let digestDay = null;
  let digestFailures = 0;
  let digestRetryAt = 0;
  let legacyModals = false; // po odrzuceniu nowego formatu okien przez Discorda używamy starego

  const today = () => B.todayIn(config.timeZone, now());

  // Zmiany jednego posta wykonujemy po kolei: dwa jednoczesne kliknięcia nie nadpiszą się nawzajem.
  function withLock(key, fn) {
    const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
    return next;
  }

  // ------------------------------------------------------------ dostęp do forum i uprawnienia
  async function getGuild() {
    return client.guilds.fetch(config.guildId);
  }

  async function botMember(guild) {
    return guild.members.me ?? guild.members.fetchMe();
  }

  // Zwraca listę brakujących uprawnień bota w kanale (puste = wszystko jest).
  async function missingPerms(channel, flags) {
    const me = await botMember(channel.guild);
    const perms = channel.permissionsFor(me);
    return flags.filter((f) => !perms || !perms.has(f));
  }

  const permNames = (flags) => flags.map((f) => PERM_NAMES.get(f) || String(f)).join(', ');

  // Kanał, który widzi ktoś, kto nie widzi forum zadań, nie nadaje się na tytuły zadań. Sprawdzamy @everyone i każdą rolę
  // (poza rolami botów); zwraca nazwę pierwszej takiej roli albo null. Uprawnienia przyznane pojedynczym osobom nie są sprawdzane.
  function leakingRole(channel, forum) {
    const roles = [...channel.guild.roles.cache.values()].filter((r) => !r.managed || r.id === channel.guild.id);
    for (const role of roles) {
      const onChannel = channel.permissionsFor(role);
      if (!onChannel || !onChannel.has(PermissionFlagsBits.ViewChannel)) continue;
      const onForum = forum && forum.permissionsFor(role);
      if (!onForum || !onForum.has(PermissionFlagsBits.ViewChannel)) return role.id === channel.guild.id ? '@everyone' : role.name;
    }
    return null;
  }

  const leakText = (role) => (role === '@everyone' ? 'jest widoczny dla wszystkich' : `jest widoczny dla roli „${role}”, która nie ma dostępu do forum`);

  const isTaskForum = (c) => Boolean(c) && c.type === ChannelType.GuildForum
    && (config.forumId ? c.id === config.forumId : B.norm(c.name) === B.norm(config.forumName));

  async function findChannel(guild, predicate) {
    const cached = guild.channels.cache.find(predicate);
    if (cached) return cached;
    const all = await guild.channels.fetch();
    return all.find((c) => c && predicate(c)) ?? null;
  }

  async function getForum() {
    const guild = await getGuild();
    const forum = await findChannel(guild, isTaskForum);
    const hidden = !forum || (await missingPerms(forum, [PermissionFlagsBits.ViewChannel])).length > 0;
    if (hidden) {
      throw new UserError(
        'Bot nie widzi forum zadań. Osoba, która obsługuje bota, powinna sprawdzić FORUM_NAME lub FORUM_ID i to, czy bot ma rolę Redakcja.',
        `Nie widzę forum "${config.forumId || config.forumName}" (brak kanału albo bot nie ma do niego dostępu).`,
      );
    }
    return forum;
  }

  function requireStatusTags(forum) {
    const st = B.statusTags(forum.availableTags);
    if (st.missing.length) {
      throw new UserError(`Na forum brakuje tagów statusu: ${st.missing.join(', ')}. Dodaj je w ustawieniach kanału (Tagi).`);
    }
    return st;
  }

  function requireAccess(forum, member) {
    const perms = member && forum.permissionsFor ? forum.permissionsFor(member) : null;
    if (!perms || !perms.has(PermissionFlagsBits.ViewChannel)) throw new UserError(NO_ACCESS_MSG, undefined, 403);
    noteSeen(member.id ?? (member.user && member.user.id));
  }

  // Osoby z dostępem do forum, które kiedykolwiek użyły bota lub strony z tablicą. Z tej listy powstaje wybór osoby na stronie
  // (bez Server Members Intent bot nie ma jak pobrać wszystkich członków serwera). Zapisujemy same numery.
  const MAX_PEOPLE = 300;
  function noteSeen(userId) {
    if (!userId) return;
    const known = store.get('people') || [];
    if (known.includes(userId)) return;
    store.set('people', [...known, userId].slice(-MAX_PEOPLE));
  }

  // Uprawnienie "Zarządzanie wątkami" osoby wykonującej akcję: z interakcji, a dla strony z tablicą z uprawnień na forum.
  function mayManage(interaction, forum) {
    if (interaction.memberPermissions) return interaction.memberPermissions.has(PermissionFlagsBits.ManageThreads);
    const perms = interaction.member && forum && forum.permissionsFor ? forum.permissionsFor(interaction.member) : null;
    return Boolean(perms && perms.has(PermissionFlagsBits.ManageThreads));
  }

  // Przydzielić można tylko osobę, która widzi forum (inaczej dostałaby pinga do zadania, którego nie otworzy).
  async function assertCanBeAssigned(forum, userId) {
    const member = await forum.guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member || member.user.bot) throw new UserError('Tej osoby nie mogę przydzielić: nie ma jej na serwerze albo to bot.');
    const perms = forum.permissionsFor(member);
    if (!perms || !perms.has(PermissionFlagsBits.ViewChannel)) {
      throw new UserError('Ta osoba nie ma dostępu do forum zadań (potrzebna rola Redakcja).');
    }
  }

  // null tylko wtedy, gdy kanał nie istnieje albo nie jest wątkiem; inne błędy (np. brak uprawnień, awaria Discorda) lecą dalej.
  async function fetchThread(id) {
    let ch;
    try {
      ch = await client.channels.fetch(id, { force: true });
    } catch (err) {
      if (err instanceof DiscordAPIError && (err.status === 404 || err.code === 10003)) return null;
      throw err;
    }
    return ch && ch.isThread() ? ch : null;
  }

  // Wysyła wiadomość i zamienia brak uprawnień na zrozumiały komunikat.
  async function sendTo(channel, payload) {
    try {
      return await channel.send(payload);
    } catch (err) {
      if (err instanceof DiscordAPIError && err.status === 403) {
        throw new UserError(NO_PERMS_MSG, `Wysyłka na ${channel.id}: ${err.message}`);
      }
      throw err;
    }
  }

  // ------------------------------------------------------------ dane zadań (osoba, termin, priorytet, karta)
  // Trzymamy je w stanie bota, więc działają także w postach założonych ręcznie. Klucze: a (osoba), d (termin oddania tekstu),
  // p (termin publikacji), u (pilne), c (id wiadomości z kartą). Brak klucza a lub d oznacza "nie ustawiono": wtedy sięgamy
  // po domyślne wartości. Termin publikacji ustawia się tylko na karcie, komendą albo na stronie (z postów go nie czytamy).
  // Rozliczenia (tylko dla zarządu, nigdy na kartę ani stronę): h (data oddania do redakcji), s (miesiąc rozliczenia tekstu),
  // b (lista premii: i, a w groszach, n, m miesiąc, s miesiąc rozliczenia, k: 'social' dla premii za social), x (zgłoszona premia za social,
  // czeka na zarząd). Kwot nie pokazujemy nigdzie poza zarządem, ale sam stan premii za social (brak, zgłoszona, zatwierdzona) widać na karcie i stronie.
  const metaOf = (id) => (store.get('tasks') || {})[id];
  function patchMeta(id, patch) {
    const all = { ...(store.get('tasks') || {}) };
    const next = { ...(all[id] || {}), ...patch };
    for (const k of ['p', 'h', 's', 'x']) if (!next[k]) delete next[k]; // puste wartości nie zostawiają śladu w stanie (w odróżnieniu od d, gdzie brak klucza znaczy "nie ustawiono")
    if (!next.b || !next.b.length) delete next.b;
    all[id] = next;
    store.set('tasks', all);
  }
  function forgetMeta(id) {
    const all = { ...(store.get('tasks') || {}) };
    if (!(id in all)) return;
    delete all[id];
    store.set('tasks', all);
  }

  // Zgodność wsteczna i posty ręczne: linie "Odpowiedzialny:" i "Termin:" z pierwszej wiadomości
  // (treść cudzych wiadomości bot widzi tylko z włączonym Message Content Intent).
  async function loadMeta(thread, day) {
    const hit = metaCache.get(thread.id);
    if (hit && now().getTime() - hit.at < META_TTL_MS) return { ...hit.meta, ok: true };
    let meta = { assigneeId: null, due: null };
    let ok = true;
    try {
      // force: bot nie dostaje zdarzeń o edycji wiadomości, więc pamięć podręczna discord.js byłaby nieaktualna
      const msg = await thread.fetchStarterMessage({ force: true });
      meta = B.parseMeta(msg?.content, day);
    } catch (err) {
      if (!isMissingMessage(err)) { ok = false; log.warn(`Nie mogę przeczytać pierwszej wiadomości posta ${thread.id}: ${err.message}`); }
    }
    if (ok) metaCache.set(thread.id, { at: now().getTime(), meta });
    return { ...meta, ok };
  }

  // Aktualny stan zadania: status z tagów, reszta z pamięci bota (z domyślnymi wartościami).
  async function resolveTask(thread, st, day) {
    const m = metaOf(thread.id) || {};
    const status = B.currentStatus(thread.appliedTags, st) ?? B.STATUSES[0];
    let assigneeId = 'a' in m ? m.a : (thread.ownerId && thread.ownerId !== client.user.id ? thread.ownerId : null);
    let due = 'd' in m ? m.d : null;
    let ok = true;
    const needA = !('a' in m);
    const needD = !('d' in m);
    if ((needA || needD) && status !== 'Opublikowane' && (config.messageContent || thread.ownerId === client.user.id)) {
      const meta = await loadMeta(thread, day);
      ok = meta.ok;
      if (needA && meta.assigneeId) assigneeId = meta.assigneeId;
      if (needD) due = meta.due;
    }
    return { status, assigneeId, due, pubDue: m.p || null, urgent: Boolean(m.u), social: settlements.socialState(thread.id), ok };
  }

  async function fetchArchivedThreads(forum) {
    const found = new Map();
    let before;
    let hasMore = false;
    for (let page = 0; page < ARCHIVE_MAX_PAGES; page += 1) {
      const res = await forum.threads.fetchArchived({ type: 'public', limit: ARCHIVE_PAGE, before });
      const sizeBefore = found.size;
      for (const [id, t] of res.threads) found.set(id, t);
      hasMore = Boolean(res.hasMore);
      if (!hasMore || found.size === sizeBefore) break;
      const oldest = Math.min(...[...res.threads.values()].map((t) => t.archiveTimestamp ?? Infinity));
      if (!Number.isFinite(oldest)) break;
      before = new Date(oldest);
    }
    return { threads: found, truncated: hasMore };
  }

  async function collectTasks(forum, st) {
    const day = today();
    const threads = new Map();
    const active = await forum.guild.channels.fetchActiveThreads();
    for (const [id, t] of active.threads) if (t.parentId === forum.id) threads.set(id, t);
    let truncated = false;
    let archiveFailed = false;
    try {
      const archived = await fetchArchivedThreads(forum);
      for (const [id, t] of archived.threads) threads.set(id, t);
      truncated = archived.truncated;
    } catch (err) {
      archiveFailed = true;
      log.error(`Nie mogę pobrać zarchiwizowanych postów: ${err.message}`);
    }
    const all = [...threads.values()];
    const tasks = [];
    let partial = archiveFailed;
    for (let i = 0; i < all.length; i += 5) {
      const batch = await Promise.all(all.slice(i, i + 5).map(async (t) => {
        const r = await resolveTask(t, st, day);
        return {
          id: t.id, name: t.name, url: t.url, status: r.status, assigneeId: r.assigneeId, due: r.due, pubDue: r.pubDue, urgent: r.urgent, social: r.social, thread: t, ok: r.ok,
        };
      }));
      for (const t of batch) { if (!t.ok) partial = true; tasks.push(t); }
    }
    const notes = [];
    if (truncated) notes.push(`Bot sprawdził ${ARCHIVE_MAX_PAGES * ARCHIVE_PAGE} najnowszych zarchiwizowanych postów, starszych nie widać.`);
    if (archiveFailed) notes.push('Nie udało się pobrać zarchiwizowanych postów.');
    if (partial && !archiveFailed) notes.push('Części terminów nie udało się pobrać.');
    return { tasks, today: day, truncated, partial, note: notes.join(' ') };
  }

  async function collectBoard() {
    const forum = await getForum();
    const st = requireStatusTags(forum);
    return collectTasks(forum, st);
  }

  // Przed każdym zapisem na kanale tablicy sprawdzamy, czy nikt nie dał do niego dostępu osobom bez dostępu do forum.
  const guard = async (channel) => {
    const role = leakingRole(channel, await getForum());
    return role ? `kanał ${leakText(role)}` : null;
  };
  const live = createLiveBoard({ client, config, store, now, log, collect: collectBoard, guard });
  const settlements = createSettlements({
    client, config, store, now, log, UserError, today, collectBoard, metaOf, patchMeta, withLock, onTask, resolveTask,
  });

  // Każda zmiana zadań podnosi wersję tablicy i odświeża żywą tablicę. Strona z przeciąganiem korzysta z tej samej wersji,
  // więc kilka osób przy ekranie nie wysyła do Discorda kilkunastu zapytań co kilka sekund.
  let boardRev = 1;
  let boardCache = null; // {at, promise}
  const BOARD_CACHE_MS = 60 * 1000;
  function touch() {
    boardRev += 1;
    boardCache = null;
    live.schedule();
  }

  // ------------------------------------------------------------ karta zadania w poście
  // Akcje, które odpowiadają "aktualizacją wiadomości" (deferUpdate): przyciski i menu karty oraz okno terminu.
  // Pozostałe (komendy, filtry, okno nowego zadania) odpowiadają prywatną wiadomością (deferReply).
  const UPDATE_IDS = new Set(['kb:prev', 'kb:next', 'kb:status', 'kb:take', 'kb:release', 'kb:assign', 'kb:duemodal']);
  const isUpdate = (i) => {
    const id = i.customId; // komendy nie mają customId
    return typeof id === 'string' && (UPDATE_IDS.has(id) || id.startsWith('kb:go:') || id.startsWith('kb:urgent:') || id.startsWith('kb:social:') || id.startsWith('kb:fin:'));
  };

  async function editCardMessage(thread, messageId, payload) {
    await thread.messages.edit(messageId, payload);
  }

  // Edytuje zarejestrowaną kartę albo zakłada nową, gdy jej nie ma.
  async function upsertCard(thread, task) {
    const payload = cardPayload(task);
    const m = metaOf(thread.id) || {};
    if (m.c) {
      try { await editCardMessage(thread, m.c, payload); return m.c; } catch (err) { if (!isMissingMessage(err)) throw err; }
    }
    const msg = await thread.send(payload);
    patchMeta(thread.id, { c: msg.id });
    return msg.id;
  }

  // Po zmianie: odświeża kartę, z której kliknięto, oraz zarejestrowaną (gdy to dwie różne wiadomości).
  async function showCard(interaction, thread, task) {
    const payload = cardPayload(task);
    const m = metaOf(thread.id) || {};
    if (!isUpdate(interaction)) { await upsertCard(thread, task); return; }
    await interaction.editReply(payload);
    const clicked = interaction.message && interaction.message.id;
    if (m.c && clicked && m.c !== clicked) await editCardMessage(thread, m.c, payload).catch(() => {});
    if (!m.c && clicked) patchMeta(thread.id, { c: clicked });
  }

  async function notifyAssignee(thread, userId, actorId) {
    if (!userId || userId === actorId) return;
    try {
      await thread.send({
        content: `<@${userId}> to zadanie jest teraz Twoje (przydzielił(a): <@${actorId}>).`,
        allowedMentions: { users: [userId] },
      });
    } catch (err) {
      log.warn(`Nie udało się powiadomić o przydziale w poście ${thread.id}: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ wspólny początek akcji na poście
  async function onTask(interaction, fn, notFoundMsg = FORUM_ONLY_MSG) {
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    const st = requireStatusTags(forum);
    return withLock(interaction.channelId, async () => {
      // Stan posta pobieramy od Discorda, bo ktoś mógł zmienić tag ręcznie albo drugim panelem.
      const thread = await fetchThread(interaction.channelId);
      if (!thread || thread.parentId !== forum.id) throw new UserError(notFoundMsg, undefined, notFoundMsg === FORUM_ONLY_MSG ? undefined : 404);
      return fn({ forum, st, thread });
    });
  }

  // Zapisuje zmianę: najpierw tagi (jeśli trzeba), potem dane zadania, na końcu odświeża tablicę, kartę i powiadamia osobę.
  // Błąd przy odświeżaniu karty (np. ktoś ją usunął) nie może zgubić reszty: zmiana jest już zapisana.
  async function applyChange(interaction, ctx, { patch = {}, tags = null, reason, pingUserId = null }) {
    const { st, thread } = ctx;
    const wasArchived = thread.archived;
    const statusBefore = tags ? B.currentStatus(thread.appliedTags, st) : null;
    if (wasArchived) await thread.setArchived(false, reason);
    try {
      if (tags) await thread.setAppliedTags(tags, reason);
    } catch (err) {
      if (wasArchived) await thread.setArchived(true, 'Kanban: cofnięcie po błędzie').catch(() => {});
      throw err;
    }
    if (Object.keys(patch).length) patchMeta(thread.id, patch);
    if (tags) settlements.noteStatusChange(thread.id, statusBefore, B.currentStatus(thread.appliedTags, st)); // data oddania do redakcji (rozliczenia)
    touch();
    const task = await resolveTask(thread, st, today());
    let cardError = null;
    try { await showCard(interaction, thread, task); } catch (err) { cardError = err; }
    if (pingUserId) await notifyAssignee(thread, pingUserId, interaction.user.id);
    if (cardError) throw cardError;
    return task;
  }

  const autoStatus = (current, hasPerson) => {
    if (hasPerson && current === 'Pomysł') return 'Przydzielone';
    if (!hasPerson && current === 'Przydzielone') return 'Pomysł';
    return current;
  };

  // Przydział (albo zwolnienie, gdy userId = null). Status Pomysł <-> Przydzielone zmienia się sam.
  // extraPatch trafia do pamięci razem z osobą, żeby nieudany przydział nie zostawił po sobie połowy zmian.
  async function assign(interaction, ctx, userId, cur, extraPatch = {}) {
    const { forum, st, thread } = ctx;
    if (userId) await assertCanBeAssigned(forum, userId);
    const target = autoStatus(cur.status, Boolean(userId));
    const tags = target !== cur.status && B.topicTags(thread.appliedTags, st).length < 5 ? B.withStatus(thread.appliedTags, st, target) : null;
    return applyChange(interaction, ctx, {
      patch: { a: userId, ...extraPatch },
      tags,
      reason: `Kanban: ${interaction.user.tag} zmienia osobę`,
      pingUserId: userId && userId !== cur.assigneeId ? userId : null, // ta sama osoba nie dostaje drugiego pinga
    });
  }

  // ------------------------------------------------------------ akcje na karcie (przyciski i menu)
  // Przyciski karty niosą docelowy stan, więc powtórne kliknięcie tego samego przycisku nic nie psuje.
  // Starsze panele mają względne przyciski kb:prev i kb:next, które nadal obsługujemy.
  // Wspólne reguły zmiany statusu dla przycisków karty i strony z tablicą. Zwraca {changed, task}.
  async function moveTo(interaction, ctx, cur, target) {
    const { st, thread } = ctx;
    if (!target || !B.STATUSES.includes(target)) throw new UserError('Nie ma takiego statusu.');
    if (target === cur.status) return { changed: false, task: cur };
    if (!B.canMove(cur.status, target, mayManage(interaction, ctx.forum))) {
      throw new UserError('Statusy „Do publikacji” i „Opublikowane” (także cofnięcie z nich) zmienia kierownictwo lub moderacja.', undefined, 403);
    }
    if (B.topicTags(thread.appliedTags, st).length >= 5) {
      throw new UserError('Ten post ma już 5 tagów tematu, a Discord pozwala na 5 tagów łącznie. Usuń jeden tag tematu, żeby zmienić status.');
    }
    const task = await applyChange(interaction, ctx, {
      tags: B.withStatus(thread.appliedTags, st, target), reason: `Kanban: ${interaction.user.tag} ustawia „${target}”`,
    });
    return { changed: true, task };
  }

  async function changeStatus(interaction) {
    await onTask(interaction, async (ctx) => {
      const { st, thread } = ctx;
      const cur = await resolveTask(thread, st, today());
      const id = interaction.customId;
      let target;
      if (interaction.isStringSelectMenu()) target = interaction.values[0];
      else if (id.startsWith('kb:go:')) target = id.slice('kb:go:'.length);
      else target = B.stepStatus(cur.status, id === 'kb:next' ? 1 : -1);
      const res = await moveTo(interaction, ctx, cur, target);
      if (!res.changed) await showCard(interaction, thread, cur);
    });
  }

  // „Biorę to”: wolne zadanie przechodzi na klikającego; jeśli już jest jego, nic się nie zmienia; cudzego nie przejmuje.
  async function doTake(interaction, ctx) {
    const cur = await resolveTask(ctx.thread, ctx.st, today());
    if (cur.assigneeId === interaction.user.id) return { changed: false, task: cur };
    if (cur.assigneeId) throw new UserError(`Zadanie ma już osobę: <@${cur.assigneeId}>. Wybierz kogoś w menu „Przydziel osobę”.`);
    return { changed: true, task: await assign(interaction, ctx, interaction.user.id, cur) };
  }

  async function takeTask(interaction) {
    await onTask(interaction, async (ctx) => {
      const res = await doTake(interaction, ctx);
      if (!res.changed) await showCard(interaction, ctx.thread, res.task);
    });
  }

  // „Zwolnij”: zdejmuje osobę tylko wtedy, gdy to klikający jest przypisany; wolne zadanie zostaje wolne.
  async function doRelease(interaction, ctx) {
    const cur = await resolveTask(ctx.thread, ctx.st, today());
    if (!cur.assigneeId) return { changed: false, task: cur };
    if (cur.assigneeId !== interaction.user.id) {
      throw new UserError(`Zadanie ma osobę: <@${cur.assigneeId}>. Zwolnić je może ona sama albo ktoś z redakcji komendą /edytuj zwolnij:True.`);
    }
    return { changed: true, task: await assign(interaction, ctx, null, cur) };
  }

  async function releaseTask(interaction) {
    await onTask(interaction, async (ctx) => {
      const res = await doRelease(interaction, ctx);
      if (!res.changed) await showCard(interaction, ctx.thread, res.task);
    });
  }

  async function assignSelected(interaction) {
    const userId = interaction.values[0];
    await onTask(interaction, async (ctx) => {
      const cur = await resolveTask(ctx.thread, ctx.st, today());
      await assign(interaction, ctx, userId, cur);
    });
  }

  // kb:urgent:on / kb:urgent:off ustawia wskazaną wartość (to nie jest przełącznik).
  async function doUrgent(interaction, ctx, want) {
    const cur = await resolveTask(ctx.thread, ctx.st, today());
    if (cur.urgent === want) return { changed: false, task: cur };
    return { changed: true, task: await applyChange(interaction, ctx, { patch: { u: want }, reason: `Kanban: ${interaction.user.tag} zmienia priorytet` }) };
  }

  async function setUrgent(interaction) {
    const want = interaction.customId === 'kb:urgent:on';
    await onTask(interaction, async (ctx) => {
      const res = await doUrgent(interaction, ctx, want);
      if (!res.changed) await showCard(interaction, ctx.thread, res.task);
    });
  }

  // Premia za social: przyciski karty niosą docelową akcję (kb:social:on, ok, off), a reguły dostępu są w module rozliczeń.
  async function doSocial(interaction, ctx, action) {
    const cur = await resolveTask(ctx.thread, ctx.st, today());
    const res = settlements.setSocial({ userId: interaction.user.id, threadId: ctx.thread.id, assigneeId: cur.assigneeId, action });
    if (!res.changed) return { changed: false, task: cur };
    return { changed: true, task: await applyChange(interaction, ctx, { reason: `Kanban: ${interaction.user.tag} zmienia premię za social` }) };
  }

  async function setSocialButton(interaction) {
    const action = interaction.customId.slice('kb:social:'.length);
    await onTask(interaction, async (ctx) => {
      const res = await doSocial(interaction, ctx, action);
      if (!res.changed) await showCard(interaction, ctx.thread, res.task);
    });
  }

  // ------------------------------------------------------------ okna (modale)
  // Nowy format okien (z listą osób) może zostać odrzucony przez Discorda (kod 50035, zły kształt formularza):
  // wtedy przechodzimy na stary, tylko z polami tekstowymi. Inne błędy (np. 40060, interakcja już obsłużona) tego nie wywołują.
  async function showModalSafe(interaction, build) {
    try {
      await interaction.showModal(build(legacyModals));
    } catch (err) {
      if (legacyModals || !(err instanceof DiscordAPIError) || err.status !== 400 || err.code !== 50035) throw err;
      legacyModals = true;
      log.warn(`Discord odrzucił nowy format okna (${err.message}). Używam starego formatu, bez listy osób.`);
      await interaction.showModal(build(true));
    }
  }

  // Terminy do podpowiedzi w oknie: zapisane na karcie albo (dla postów z linią "Termin:") odczytany z treści posta termin oddania.
  // Okno trzeba pokazać w 3 sekundy, więc odczyt z Discorda ma limit czasu; bez wyniku pole zostaje puste.
  async function datesForModal(channelId) {
    const m = metaOf(channelId) || {};
    const pubDue = m.p || null;
    if ('d' in m) return { due: m.d || null, pubDue };
    const read = (async () => {
      const forum = await getForum();
      const st = requireStatusTags(forum);
      const thread = await fetchThread(channelId);
      return thread && thread.parentId === forum.id ? (await resolveTask(thread, st, today())).due : null;
    })().catch(() => null);
    const due = await Promise.race([read, new Promise((resolve) => { setTimeout(() => resolve(null), 1200).unref(); })]);
    return { due: due || null, pubDue };
  }

  async function openDueModal(interaction) {
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    const current = await datesForModal(interaction.channelId);
    await showModalSafe(interaction, (legacy) => dueModal(current, { legacy }));
  }

  // Pusty tekst oznacza brak terminu; zły format to błąd widoczny dla użytkownika.
  function parseDue(rawInput, badMessage = BAD_DATE_MSG) {
    const raw = String(rawInput ?? '').trim();
    if (!raw) return null;
    const due = B.normalizeDate(raw, today());
    if (!due) throw new UserError(badMessage);
    return due;
  }

  // Pole okna, którego może nie być (okno otwarte jeszcze przed aktualizacją bota): undefined znaczy "bez zmian".
  function optionalField(interaction, id) {
    try { return interaction.fields.getTextInputValue(id); } catch { return undefined; }
  }

  async function submitDue(interaction) {
    const due = parseDue(interaction.fields.getTextInputValue('due'));
    const pubRaw = optionalField(interaction, 'pubdue');
    const patch = { d: due };
    if (pubRaw !== undefined) patch.p = parseDue(pubRaw, BAD_PUB_DATE_MSG);
    await onTask(interaction, async (ctx) => {
      await applyChange(interaction, ctx, { patch, reason: `Kanban: ${interaction.user.tag} zmienia terminy` });
    });
  }

  async function openNewModal(interaction) {
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    await showModalSafe(interaction, (legacy) => newTaskModal({ legacy }));
  }

  // Przycisk na tablicy uruchamia stronę z przeciąganiem jako Activity (odpowiedź typu "uruchom aplikację").
  async function openActivity(interaction) {
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    try {
      await interaction.launchActivity();
    } catch (err) {
      if (!(err instanceof DiscordAPIError)) throw err;
      throw new UserError(
        `Discord nie uruchomił Activity (to bywa ograniczone do małych serwerów i testerów aplikacji).${config.web.publicUrl ? ` Otwórz tablicę w przeglądarce: ${config.web.publicUrl}` : ''}`,
        `Uruchomienie Activity nie wyszło: ${err.message}`,
      );
    }
  }

  // „termin 05.11.2026, publikacja 12.11.2026” do odpowiedzi bota (pusty tekst, gdy nie ustawiono żadnego).
  const datesInfo = (due, pubDue) => [due ? `termin ${B.fmtDate(due)}` : null, pubDue ? `publikacja ${B.fmtDate(pubDue)}` : null].filter(Boolean).join(', ');

  function fieldText(interaction, id) {
    try { return interaction.fields.getTextInputValue(id).trim(); } catch { return ''; }
  }

  async function submitNew(interaction) {
    let person = null;
    try { person = interaction.fields.getSelectedUsers('person')?.first() ?? null; } catch { person = null; }
    const { thread, due, pubDue } = await createTask(interaction, {
      title: fieldText(interaction, 'title'), personId: person ? person.id : null,
      dueRaw: fieldText(interaction, 'due'), pubRaw: fieldText(interaction, 'pubdue'), description: fieldText(interaction, 'desc'),
    });
    const info = datesInfo(due, pubDue);
    await interaction.editReply({ content: `Dodano zadanie${info ? ` (${info})` : ''}: ${thread.url}`, allowedMentions: NO_MENTIONS });
  }

  // ------------------------------------------------------------ tworzenie zadania
  async function createTask(interaction, { title, personId, dueRaw, pubRaw = '', description }) {
    const name = Array.from(String(title || '').trim()).slice(0, 100).join('');
    if (!name) throw new UserError('Podaj tytuł zadania.');
    let due = null;
    if (dueRaw) {
      due = B.normalizeDate(dueRaw, today());
      if (!due) throw new UserError(BAD_DATE_MSG);
    }
    const pubDue = parseDue(pubRaw, BAD_PUB_DATE_MSG);
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    const st = requireStatusTags(forum);
    if (personId) await assertCanBeAssigned(forum, personId);
    const status = personId ? 'Przydzielone' : 'Pomysł';
    const thread = await forum.threads.create({
      name,
      message: { content: B.buildStarterContent({ description, authorId: interaction.user.id }), allowedMentions: NO_MENTIONS },
      appliedTags: [st.byName.get(status).id],
      reason: `Kanban: nowe zadanie od ${interaction.user.tag}`,
    });
    patchMeta(thread.id, { a: personId, d: due, p: pubDue, u: false });
    metaCache.delete(thread.id);
    try {
      const msg = await thread.send(cardPayload({ status, assigneeId: personId, due, pubDue, urgent: false, social: settlements.enabled ? 'none' : null }));
      patchMeta(thread.id, { c: msg.id });
    } catch (err) {
      log.error(`Karta w poście ${thread.id}: ${err.message}`);
    }
    await notifyAssignee(thread, personId, interaction.user.id);
    touch();
    return { thread, due, pubDue };
  }

  // ------------------------------------------------------------ komendy
  async function cmdTablica(interaction) {
    const isPublic = interaction.options.getBoolean('publicznie') === true;
    const mine = interaction.options.getBoolean('moje') === true;
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    const st = requireStatusTags(forum);
    let target = null;
    if (isPublic) {
      target = interaction.channel ?? await client.channels.fetch(interaction.channelId);
      if (!target || !target.isTextBased() || leakingRole(target, forum)) {
        throw new UserError('Publiczną tablicę można wysłać tylko na kanał, którego nie widzą osoby spoza redakcji. Użyj komendy bez opcji „publicznie” albo wejdź na kanał redakcji.');
      }
    }
    const { tasks, today: day, note } = await collectTasks(forum, st);
    const embed = B.renderBoard(tasks, day, { onlyUserId: mine ? interaction.user.id : null, note });
    const payload = { embeds: [new EmbedBuilder(embed)], allowedMentions: NO_MENTIONS };
    if (isPublic) {
      // Odpowiedź na komendę zostaje prywatna (Discord nie pozwala zmienić jej na publiczną po odroczeniu),
      // a tablicę wysyłamy jako zwykłą wiadomość na kanał.
      await sendTo(target, payload);
      await interaction.editReply({ content: 'Wysłano tablicę na ten kanał.', allowedMentions: NO_MENTIONS });
    } else {
      await interaction.editReply(payload);
    }
  }

  async function cmdZadanie(interaction) {
    const person = interaction.options.getUser('osoba');
    const { thread, due, pubDue } = await createTask(interaction, {
      title: interaction.options.getString('tytul', true),
      personId: person ? person.id : null,
      dueRaw: interaction.options.getString('termin'),
      pubRaw: interaction.options.getString('publikacja') || '',
      description: (interaction.options.getString('opis') || '').trim(),
    });
    const info = [person ? 'Przydzielone' : 'Pomysł', datesInfo(due, pubDue)].filter(Boolean).join(', ');
    await interaction.editReply({ content: `Dodano zadanie (${info}): ${thread.url}`, allowedMentions: NO_MENTIONS });
  }

  async function cmdEdytuj(interaction) {
    const dueRaw = interaction.options.getString('termin');
    const pubRaw = interaction.options.getString('publikacja');
    const person = interaction.options.getUser('osoba');
    const release = interaction.options.getBoolean('zwolnij') === true;
    if (!dueRaw && !pubRaw && !person && !release) throw new UserError('Podaj nowy termin, termin publikacji, osobę albo wybierz „zwolnij”.');
    if (person && release) throw new UserError('Wybierz osobę albo „zwolnij”, nie oba naraz.');
    // undefined: bez zmian, null: usuń termin
    const parse = (raw, bad) => {
      if (!raw) return undefined;
      if (/^(brak|usun|usuń|-)$/i.test(raw.trim())) return null;
      const date = B.normalizeDate(raw, today());
      if (!date) throw new UserError(`${bad} Albo wpisz „brak”, żeby usunąć termin.`);
      return date;
    };
    const due = parse(dueRaw, BAD_DATE_MSG);
    const pubDue = parse(pubRaw, BAD_PUB_DATE_MSG);
    const patch = {};
    if (due !== undefined) patch.d = due;
    if (pubDue !== undefined) patch.p = pubDue;
    let url = '';
    await onTask(interaction, async (ctx) => {
      const { thread, st } = ctx;
      url = thread.url;
      const cur = await resolveTask(thread, st, today());
      if (person || release) {
        await assign(interaction, ctx, person ? person.id : null, cur, patch);
      } else {
        await applyChange(interaction, ctx, { patch, reason: `Kanban: ${interaction.user.tag} zmienia terminy` });
      }
    });
    const parts = [];
    if (due !== undefined) parts.push(due ? `termin ${B.fmtDate(due)}` : 'bez terminu');
    if (pubDue !== undefined) parts.push(pubDue ? `publikacja ${B.fmtDate(pubDue)}` : 'bez terminu publikacji');
    await interaction.editReply({ content: `Zaktualizowano zadanie${parts.length ? ` (${parts.join(', ')})` : ''}: ${url}`, allowedMentions: NO_MENTIONS });
  }

  async function cmdPanel(interaction) {
    await onTask(interaction, async ({ st, thread }) => {
      const task = await resolveTask(thread, st, today());
      const old = (metaOf(thread.id) || {}).c;
      const msg = await thread.send(cardPayload(task));
      patchMeta(thread.id, { c: msg.id });
      if (old) await thread.messages.delete(old).catch(() => {});
    });
    await interaction.editReply({ content: 'Dodano kartę zadania w tym poście.' });
  }

  async function buildDigest({ allowPartial }) {
    const { tasks, today: day, partial, note } = await collectBoard();
    if (partial && !allowPartial) throw new TransientError('Nie udało się pobrać części zadań.');
    return B.renderDigest(tasks, day, { note });
  }

  async function cmdPodsumowanie(interaction) {
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    const digest = await buildDigest({ allowPartial: true });
    if (!digest) { await interaction.editReply({ content: 'Nic nie czeka: brak zadań po terminie, z bliskim terminem, bez osoby, do redakcji ani do publikacji.' }); return; }
    await interaction.editReply({ embeds: [new EmbedBuilder(digest.embed)], allowedMentions: NO_MENTIONS });
  }

  async function cmdUstawTablice(interaction) {
    const may = interaction.memberPermissions ? interaction.memberPermissions.has(PermissionFlagsBits.ManageThreads) : false;
    if (!may) throw new UserError('Żywą tablicę ustawia kierownictwo lub moderacja.');
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    const ch = interaction.channel ?? await client.channels.fetch(interaction.channelId);
    if (!ch || ch.type !== ChannelType.GuildText) throw new UserError('Żywą tablicę można ustawić tylko na zwykłym kanale tekstowym.');
    const leak = leakingRole(ch, forum);
    if (leak) {
      throw new UserError(`Ten kanał ${leakText(leak)}, a tablica pokazuje tytuły z prywatnego forum. Wejdź na kanał w kategorii REDAKCJA.`);
    }
    const lacking = await missingPerms(ch, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]);
    if (lacking.length) throw new UserError(`Bot nie może pisać na tym kanale. Brakuje: ${permNames(lacking)}.`);
    await live.setup(ch);
    await interaction.editReply({ content: 'Gotowe: tablica jest na tym kanale i odświeża się sama.' });
  }

  async function filterView(interaction) {
    const kind = interaction.values[0];
    if (!(kind in B.FILTERS)) throw new UserError('Nie ma takiego widoku.');
    const forum = await getForum();
    requireAccess(forum, interaction.member);
    const st = requireStatusTags(forum);
    const { tasks, today: day, note } = await collectTasks(forum, st);
    const list = B.filterTasks(tasks, kind, interaction.user.id, day);
    await interaction.editReply({ embeds: [new EmbedBuilder(B.renderList(B.FILTERS[kind], list, day, { note }))], allowedMentions: NO_MENTIONS });
  }

  // ------------------------------------------------------------ zdarzenia o wątkach
  const forumOf = (thread) => {
    if (!thread || thread.guildId !== config.guildId) return null;
    const parent = thread.parent ?? thread.guild.channels.cache.get(thread.parentId);
    return isTaskForum(parent) ? parent : null;
  };

  // Nowy post założony ręcznie: dostaje status Pomysł (jeśli go nie ma) i kartę.
  async function onThreadCreate(thread, newlyCreated) {
    try {
      const forum = forumOf(thread);
      if (!forum) return;
      touch();
      if (!newlyCreated || thread.ownerId === client.user.id) return;
      const st = B.statusTags(forum.availableTags);
      if (st.missing.length) return;
      await withLock(thread.id, async () => {
        let status = B.currentStatus(thread.appliedTags, st);
        if (!status) {
          if (B.topicTags(thread.appliedTags, st).length >= 5) {
            log.warn(`Nowy post ${thread.id} ma już 5 tagów tematu, więc nie dodaję statusu ani karty.`);
            return;
          }
          status = B.STATUSES[0];
          await thread.setAppliedTags(B.withStatus(thread.appliedTags, st, status), 'Kanban: domyślny status nowego posta');
        }
        const task = await resolveTask(thread, st, today());
        const msg = await thread.send(cardPayload(task));
        patchMeta(thread.id, { c: msg.id });
      });
    } catch (err) {
      log.error(`Nowy post ${thread && thread.id}: ${err.message}`);
    }
  }

  // Ręczna zmiana tagu statusu w Discordzie też zapisuje datę oddania tekstu (zmiany bota widzimy już w applyChange).
  function onThreadUpdate(old, thread) {
    const forum = forumOf(thread);
    if (!forum) return;
    touch();
    try {
      const st = B.statusTags(forum.availableTags);
      if (st.missing.length || !old || !old.appliedTags) return;
      settlements.noteStatusChange(thread.id, B.currentStatus(old.appliedTags, st), B.currentStatus(thread.appliedTags, st));
    } catch (err) {
      log.error(`Zmiana posta ${thread.id}: ${err.message}`);
    }
  }

  function onThreadDelete(thread) {
    if (!forumOf(thread)) return;
    forgetMeta(thread.id);
    metaCache.delete(thread.id);
    touch();
  }

  // ------------------------------------------------------------ podsumowanie dnia
  async function findDigestChannel(guild) {
    const label = config.digestChannelId || config.digestChannelName;
    if (config.digestChannelId) {
      const ch = await findChannel(guild, (c) => c.id === config.digestChannelId);
      if (!ch || !ch.isTextBased()) throw new UserError(`Nie widzę kanału podsumowania "${label}".`);
      return ch; // kanał wskazany numerem to świadomy wybór: nie sprawdzamy, kto go widzi
    }
    const named = guild.channels.cache.filter((c) => c && c.type === ChannelType.GuildText && B.norm(c.name) === B.norm(label));
    const all = named.size ? named : (await guild.channels.fetch()).filter((c) => c && c.type === ChannelType.GuildText && B.norm(c.name) === B.norm(label));
    if (!all.size) throw new UserError(`Nie widzę kanału podsumowania "${label}".`);
    const forum = await getForum();
    const hidden = all.find((c) => !leakingRole(c, forum));
    if (!hidden) {
      throw new UserError(`Kanał "${label}" ${leakText(leakingRole(all.first(), forum))}, a podsumowanie zawiera tytuły z prywatnego forum. Ustaw DIGEST_CHANNEL_ID na kanał redakcji.`);
    }
    return hidden;
  }

  async function postDigest({ allowPartial }) {
    const guild = await getGuild();
    const channel = await findDigestChannel(guild);
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    const lacking = await missingPerms(channel, need);
    if (lacking.length) throw new UserError(`Bot nie może pisać na kanale podsumowania. Brakuje: ${permNames(lacking)}.`);
    const digest = await buildDigest({ allowPartial });
    if (!digest) return false;
    const ping = config.digestPing && digest.pingIds.length > 0;
    await sendTo(channel, {
      content: ping ? digest.pingIds.map((id) => `<@${id}>`).join(' ') : undefined,
      embeds: [new EmbedBuilder(digest.embed)],
      allowedMentions: ping ? { users: digest.pingIds } : NO_MENTIONS,
    });
    return true;
  }

  async function digestTick() {
    if (!config.digestEnabled || digestBusy) return;
    const t = now();
    if (!B.shouldSendDigest({
      now: t, timeZone: config.timeZone, hour: config.digestHour,
      weekdays: config.digestWeekdays, lastSentIso: store.get('lastDigest'),
    })) return;
    const day = B.todayIn(config.timeZone, t);
    if (digestDay !== day) { digestDay = day; digestFailures = 0; digestRetryAt = 0; }
    if (t.getTime() < digestRetryAt) return;
    digestBusy = true;
    try {
      const sent = await postDigest({ allowPartial: digestFailures >= 2 });
      store.set('lastDigest', day);
      log.log(sent ? 'Wysłano podsumowanie dnia.' : 'Podsumowanie dnia: nic do pokazania.');
    } catch (err) {
      if (err instanceof UserError || isPermanentDiscordError(err)) {
        store.set('lastDigest', day); // błąd konfiguracji lub uprawnień: nie ponawiaj co minutę
        log.error(`Podsumowanie dnia pominięte: ${err.detail || err.message}`);
      } else {
        digestFailures += 1;
        digestRetryAt = t.getTime() + DIGEST_RETRY_MS;
        if (digestFailures >= DIGEST_MAX_FAILURES) {
          store.set('lastDigest', day);
          log.error(`Podsumowanie dnia nie wyszło ${digestFailures} razy, rezygnuję do jutra: ${err.message}`);
        } else {
          log.error(`Podsumowanie dnia nie wyszło (próba ${digestFailures}, następna za 10 minut): ${err.message}`);
        }
      }
    } finally {
      digestBusy = false;
    }
  }

  // ------------------------------------------------------------ odpowiedzi i router interakcji
  async function say(interaction, content) {
    const payload = { content, flags: EPHEMERAL, allowedMentions: NO_MENTIONS };
    if (isUpdate(interaction) && (interaction.deferred || interaction.replied)) return interaction.followUp(payload);
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content, allowedMentions: NO_MENTIONS });
    return interaction.reply(payload);
  }

  function userText(err) {
    if (err instanceof UserError) return err.message;
    if (err instanceof DiscordAPIError && (err.code === 50001 || err.code === 50013)) return NO_PERMS_MSG;
    return GENERIC_ERROR_MSG;
  }

  const COMMANDS = {
    tablica: cmdTablica,
    zadanie: cmdZadanie,
    edytuj: cmdEdytuj,
    panel: cmdPanel,
    podsumowanie: cmdPodsumowanie,
    'ustaw-tablice': cmdUstawTablice,
    rozliczenia: (interaction) => settlements.command(interaction),
  };

  // Przyciski i menu, które odpowiadają "aktualizacją wiadomości" (odroczenie tego samego typu).
  const UPDATING = {
    'kb:prev': changeStatus, 'kb:next': changeStatus, 'kb:status': changeStatus,
    'kb:take': takeTask, 'kb:release': releaseTask, 'kb:assign': assignSelected,
  };
  const updatingHandler = (id) => {
    if (id.startsWith('kb:go:')) return changeStatus;
    if (id.startsWith('kb:urgent:')) return setUrgent;
    if (id.startsWith('kb:social:')) return setSocialButton;
    return UPDATING[id];
  };

  async function onInteraction(interaction) {
    try {
      // Przyciski i menu szkicu rozliczeń przychodzą z wiadomości prywatnych (bez numeru serwera); sprawdza je moduł rozliczeń.
      if (!interaction.guildId && (interaction.isButton() || interaction.isAnySelectMenu()) && String(interaction.customId).startsWith('kb:fin:')) {
        await interaction.deferUpdate();
        await settlements.onComponent(interaction);
        return;
      }
      if (interaction.guildId !== config.guildId) return;
      // Discord daje 3 sekundy na pierwszą odpowiedź, a pobranie forum i wątków bywa wolniejsze: odpowiadamy od razu.
      if (interaction.isChatInputCommand()) {
        log.log(`/${interaction.commandName} od ${interaction.user.tag}`);
        await interaction.deferReply({ flags: EPHEMERAL });
        const run = COMMANDS[interaction.commandName];
        if (!run) { await interaction.editReply({ content: 'Nie znam tej komendy. Odśwież Discorda (Ctrl+R) i spróbuj ponownie.' }); return; }
        await run(interaction);
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'kb:duemodal') {
          if (interaction.isFromMessage()) await interaction.deferUpdate(); else await interaction.deferReply({ flags: EPHEMERAL });
          await submitDue(interaction);
        } else if (interaction.customId === 'kb:newmodal') {
          await interaction.deferReply({ flags: EPHEMERAL });
          await submitNew(interaction);
        }
        return;
      }
      if (interaction.isButton() || interaction.isAnySelectMenu()) {
        const id = interaction.customId;
        if (id === 'kb:due') { await openDueModal(interaction); return; }
        if (id === 'kb:new') { await openNewModal(interaction); return; }
        if (id === 'kb:activity') { await openActivity(interaction); return; }
        if (id === 'kb:filter') { await interaction.deferReply({ flags: EPHEMERAL }); await filterView(interaction); return; }
        const run = updatingHandler(id);
        if (run) { await interaction.deferUpdate(); await run(interaction); }
      }
    } catch (err) {
      if (!(err instanceof UserError)) log.error(`Interakcja ${interaction.commandName || interaction.customId}: ${err.stack || err.message}`);
      else if (err.detail) log.warn(err.detail);
      try { await say(interaction, userText(err)); } catch (e2) { log.error(`Nie mogę odpowiedzieć: ${e2.message}`); }
    }
  }

  async function selfCheck() {
    try {
      const forum = await getForum();
      const st = B.statusTags(forum.availableTags);
      if (st.missing.length) log.warn(`UWAGA: na forum "${forum.name}" brakuje tagów statusu: ${st.missing.join(', ')}.`);
      else log.log(`Forum "${forum.name}": tagi statusu są na miejscu.`);
      for (const status of B.RESTRICTED) {
        const tag = st.byName.get(status);
        if (tag && !tag.moderated) {
          log.warn(`UWAGA: tag "${tag.name}" nie jest moderowany, więc każdy autor posta może go ustawić ręcznie w Discordzie. Zaznacz "Moderowany" w ustawieniach forum (Tagi).`);
        }
      }
      const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads];
      const lacking = await missingPerms(forum, need);
      if (lacking.length) log.warn(`UWAGA: bot nie ma na forum uprawnień: ${permNames(lacking)}. Część funkcji nie zadziała.`);
      if (!config.messageContent) log.log('Message Content wyłączone: terminy i osoby z ręcznie napisanych linii w postach odczytam dopiero po włączeniu MESSAGE_CONTENT=1. Termin i osobę ustawisz przyciskami na karcie.');
    } catch (err) {
      log.warn(`UWAGA: ${err.detail || err.message}`);
    }
    if (config.digestEnabled) {
      try {
        const channel = await findDigestChannel(await getGuild());
        const lacking = await missingPerms(channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
        if (lacking.length) log.warn(`UWAGA: bot nie ma na kanale podsumowania uprawnień: ${permNames(lacking)}.`);
      } catch (err) {
        log.warn(`UWAGA: podsumowanie dnia nie zadziała: ${err.detail || err.message}`);
      }
    }
    const board = live.info();
    if (board) { log.log(`Żywa tablica: kanał ${board.channelId}.`); live.schedule(); }
    else log.log('Żywa tablica nie jest ustawiona: wejdź na kanał w kategorii REDAKCJA i wpisz /ustaw-tablice.');
  }


  // ------------------------------------------------------------ dostęp dla strony z tablicą (bez interakcji Discorda)
  // Strona zna tylko numer osoby zalogowanej kontem Discorda. Uprawnienia sprawdzamy tu, po stronie bota, na podstawie
  // aktualnych ról: komuś, komu zabrano rolę Redakcja, dostęp znika najpóźniej po pół minuty.
  const SNOWFLAKE = /^\d{15,25}$/;
  const ACTOR_TTL_MS = 30 * 1000;
  const PEOPLE_TTL_MS = 5 * 60 * 1000;
  const PUBLISHED_ON_PAGE = 30;
  const actors = new Map();
  let peopleCache = null; // {at, list}
  const NO_TASK_MSG = 'Nie ma takiego zadania. Mogło zostać usunięte, odśwież tablicę.';

  async function actorFor(userId) {
    if (!SNOWFLAKE.test(String(userId))) throw new UserError(NO_ACCESS_MSG, undefined, 403);
    const hit = actors.get(userId);
    if (hit && Date.now() - hit.at < ACTOR_TTL_MS) return hit.actor;
    const forum = await getForum();
    const member = await forum.guild.members.fetch({ user: userId, force: true }).catch((err) => {
      if (err instanceof DiscordAPIError && (err.status === 404 || err.code === 10007)) return null;
      throw err;
    });
    if (!member || member.user.bot) throw new UserError(NO_ACCESS_MSG, undefined, 403);
    requireAccess(forum, member);
    // Kształt jak interakcja Discorda w tych polach, z których korzystają wspólne funkcje (osoba, członek, uprawnienia).
    const actor = { user: member.user, member, memberPermissions: null, guildId: config.guildId };
    actors.set(userId, { at: Date.now(), actor });
    return actor;
  }

  const webTask = (thread, r) => ({
    id: thread.id, name: thread.name, url: thread.url, status: r.status, assigneeId: r.assigneeId, due: r.due, pubDue: r.pubDue || null, urgent: Boolean(r.urgent),
    social: r.social || null, // stan premii za social (null = rozliczenia wyłączone), nigdy kwota
  });

  // Wspólny początek zmian z poziomu strony: blokada posta, świeży stan z Discorda, te same reguły co przy przyciskach karty.
  function webTaskOp(actor, threadId, fn) {
    if (!SNOWFLAKE.test(String(threadId))) return Promise.reject(new UserError(NO_TASK_MSG, undefined, 404));
    const px = { ...actor, channelId: String(threadId) };
    return onTask(px, async (ctx) => webTask(ctx.thread, (await fn(ctx, px)).task), NO_TASK_MSG);
  }

  // Zrzut tablicy dla strony: te same dane co żywa tablica, w kolejności kolumn. Trzymany do pierwszej zmiany (najwyżej minutę).
  function boardSnapshot() {
    if (boardCache && Date.now() - boardCache.at < BOARD_CACHE_MS) return boardCache.promise;
    const rev = boardRev;
    const promise = collectBoard().then(({ tasks, today: day, note }) => {
      const out = [];
      let publishedTotal = 0;
      for (const status of B.STATUSES) {
        const col = tasks.filter((t) => t.status === status);
        col.sort(status === 'Opublikowane' ? B.newestFirst : B.compareTasks);
        if (status === 'Opublikowane') publishedTotal = col.length;
        for (const t of (status === 'Opublikowane' ? col.slice(0, PUBLISHED_ON_PAGE) : col)) {
          out.push({ id: t.id, name: t.name, url: t.url, status: t.status, assigneeId: t.assigneeId, due: t.due, pubDue: t.pubDue || null, urgent: Boolean(t.urgent), social: t.social || null });
        }
      }
      return { rev, today: day, note, publishedTotal, tasks: out };
    });
    boardCache = { at: Date.now(), promise };
    promise.catch(() => { if (boardCache && boardCache.promise === promise) boardCache = null; });
    return promise;
  }

  async function listGuildMembers(guild) {
    const ids = [];
    let after;
    for (let page = 0; page < 10; page += 1) {
      const res = await guild.members.list({ limit: 1000, after });
      for (const m of res.values()) ids.push(m.id);
      if (res.size < 1000) break;
      after = [...res.keys()].reduce((a, b) => (B.compareIds(a, b) >= 0 ? a : b));
    }
    return ids;
  }

  // Osoby, które można przydzielić: widzą forum i są znane botowi (korzystały z niego albo ze strony), mają zadania albo,
  // przy MEMBERS_INTENT=1, wszyscy członkowie z dostępem do forum.
  async function listPeople(actor, snapshot) {
    if (peopleCache && Date.now() - peopleCache.at < PEOPLE_TTL_MS && peopleCache.list.some((p) => p.id === actor.user.id)) return peopleCache.list;
    const forum = await getForum();
    const ids = new Set([...(store.get('people') || []), actor.user.id]);
    for (const t of snapshot.tasks) if (t.assigneeId) ids.add(t.assigneeId);
    if (config.web.membersIntent) {
      try { for (const id of await listGuildMembers(forum.guild)) ids.add(id); } catch (err) { log.warn(`Nie mogę pobrać listy członków (czy włączono Server Members Intent?): ${err.message}`); }
    }
    const list = [];
    for (const id of ids) {
      if (!SNOWFLAKE.test(id)) continue;
      const member = forum.guild.members.cache.get(id) ?? await forum.guild.members.fetch({ user: id }).catch(() => null);
      if (!member || member.user.bot) continue;
      const perms = forum.permissionsFor(member);
      if (!perms || !perms.has(PermissionFlagsBits.ViewChannel)) continue;
      list.push({ id, name: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64, extension: 'png', forceStatic: true }) });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    peopleCache = { at: Date.now(), list };
    return list;
  }

  const web = {
    actor: actorFor,
    forget: () => { actors.clear(); peopleCache = null; boardCache = null; },
    revision: () => boardRev,
    async me(actor) {
      const forum = await getForum();
      return { id: actor.user.id, name: actor.member.displayName, canManage: mayManage(actor, forum), finance: settlements.isFinance(actor.user.id) };
    },
    board: () => boardSnapshot(),
    people: async (actor) => listPeople(actor, await boardSnapshot()),
    move: (actor, id, status) => webTaskOp(actor, id, async (ctx, px) => moveTo(px, ctx, await resolveTask(ctx.thread, ctx.st, today()), status)),
    take: (actor, id) => webTaskOp(actor, id, (ctx, px) => doTake(px, ctx)),
    release: (actor, id) => webTaskOp(actor, id, (ctx, px) => doRelease(px, ctx)),
    assign: (actor, id, userId) => webTaskOp(actor, id, async (ctx, px) => {
      const cur = await resolveTask(ctx.thread, ctx.st, today());
      if ((userId || null) === (cur.assigneeId || null)) return { changed: false, task: cur };
      return { changed: true, task: await assign(px, ctx, userId || null, cur) };
    }),
    // Terminy ze strony: undefined = bez zmian, pusty tekst lub null = usuń termin. Obie zmiany idą jednym zapisem i jedną blokadą.
    due: (actor, id, raw, pubRaw) => webTaskOp(actor, id, async (ctx, px) => {
      const patch = {};
      if (raw !== undefined) patch.d = parseDue(raw);
      if (pubRaw !== undefined) patch.p = parseDue(pubRaw, BAD_PUB_DATE_MSG);
      const cur = await resolveTask(ctx.thread, ctx.st, today());
      const same = (!('d' in patch) || (patch.d || null) === (cur.due || null)) && (!('p' in patch) || (patch.p || null) === (cur.pubDue || null));
      if (same) return { changed: false, task: cur };
      return { changed: true, task: await applyChange(px, ctx, { patch, reason: `Kanban: ${px.user.tag} zmienia terminy` }) };
    }),
    urgent: (actor, id, want) => webTaskOp(actor, id, (ctx, px) => doUrgent(px, ctx, Boolean(want))),
    social: (actor, id, action) => webTaskOp(actor, id, (ctx, px) => doSocial(px, ctx, action)),
    async create(actor, { title, userId, due, pubDue, description }) {
      const { thread } = await createTask(actor, {
        title, personId: userId || null, dueRaw: String(due ?? '').trim(), pubRaw: String(pubDue ?? '').trim(), description: String(description ?? '').trim().slice(0, 1500),
      });
      const st = requireStatusTags(await getForum());
      return webTask(thread, await resolveTask(thread, st, today()));
    },
  };

  return {
    onInteraction, onThreadCreate, onThreadUpdate, onThreadDelete, digestTick, liveTick: () => live.tick(), financeTick: () => settlements.financeTick(),
    selfCheck, collectTasks, getForum, live, web,
  };
}

module.exports = { createBot, UserError };
