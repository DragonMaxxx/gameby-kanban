// Autor: Mateusz Bartoszewicz
// Start strony: ustalenie trybu (Activity albo przeglądarka), logowanie, pierwsze pobranie tablicy i odświeżanie w tle.
import { h, clear, icon, toast } from './dom.js';
import { api, configureApi } from './api.js';
import { createStore, FILTERS } from './store.js';
import { createBoard } from './board.js';
import { createDrag } from './drag.js';
import { createDialogs } from './dialogs.js';
import { createActions } from './actions.js';
import { avatarEl } from './people.js';
import { isActivity, startActivity, startWeb, ERROR_TEXT } from './auth.js';

const POLL_MS = 8000;
const PEOPLE_REFRESH_MS = 5 * 60 * 1000;
const app = document.getElementById('app');
const activity = isActivity();

function showScreen({ title, text, error = false, spinner = false, buttons = [] }) {
  clear(app);
  app.append(h('div', { class: 'center-screen' }, h('div', { class: 'center-card' },
    spinner ? h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Ładowanie' }) : null,
    title ? h('h1', { text: title }) : null,
    text ? h('p', { class: error ? 'error' : '', role: error ? 'alert' : null, text }) : null,
    ...buttons.map((b) => h('button', { type: 'button', class: `btn${b.primary ? ' primary' : ''}`, text: b.label, onClick: b.onClick })))));
}

const reload = () => window.location.reload();

function showLogin(config, message) {
  if (!config.web) {
    showScreen({
      title: 'Tablica redakcji GameBy',
      text: 'Logowanie w przeglądarce jest wyłączone. Otwórz tablicę z poziomu Discorda (przycisk na kanale z tablicą).',
      error: Boolean(message),
    });
    return;
  }
  showScreen({
    title: 'Tablica redakcji GameBy',
    text: message || 'Zaloguj się kontem Discord, żeby zobaczyć i przesuwać zadania.',
    error: Boolean(message),
    buttons: [{ label: 'Zaloguj przez Discord', primary: true, onClick: () => { window.location.href = '/auth/login'; } }],
  });
}

function showDenied(config) {
  showScreen({
    title: 'Brak dostępu',
    text: 'To konto nie ma dostępu do forum redakcji. Jeśli powinno mieć, poproś o rolę Redakcja i spróbuj ponownie.',
    error: true,
    buttons: activity ? [{ label: 'Spróbuj ponownie', onClick: reload }] : [{ label: 'Wyloguj', onClick: () => logout(config) }],
  });
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* i tak wracamy na ekran logowania */ }
  reload();
}

async function boot() {
  if (activity) configureApi({ prefix: '/.proxy' });
  showScreen({ spinner: true, text: activity ? 'Łączę z Discordem…' : 'Ładuję tablicę…' });

  let config;
  try {
    config = (await api('GET', '/api/config')).data;
  } catch {
    showScreen({ title: 'Brak połączenia', text: 'Nie mogę połączyć się z serwerem tablicy. Sprawdź, czy bot działa.', error: true, buttons: [{ label: 'Spróbuj ponownie', primary: true, onClick: reload }] });
    return;
  }

  let session;
  if (activity) {
    try {
      session = await startActivity(config.clientId);
    } catch (err) {
      if (err && err.status === 403) { showDenied(config); return; }
      showScreen({ title: 'Nie udało się uruchomić tablicy', text: err && err.message ? err.message : 'Spróbuj ponownie.', error: true, buttons: [{ label: 'Spróbuj ponownie', primary: true, onClick: reload }] });
      return;
    }
  } else {
    session = startWeb();
    const code = new URLSearchParams(window.location.search).get('blad');
    if (code) {
      window.history.replaceState(null, '', '/');
      showLogin(config, Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : ERROR_TEXT.logowanie);
      return;
    }
  }

  const store = createStore();
  store.state.activity = activity;
  let etag = null;
  let loading = false;
  let failures = 0;
  let timer = 0;
  let deferred = null;
  let renderPending = false;
  let lastPeopleAt = 0;
  let peopleLoading = false;
  let drag = null;
  let rerun = false; // po bieżącym odświeżaniu trzeba pobrać tablicę jeszcze raz (zmiana trwała lub skończyła się w jego trakcie)
  let ended = false; // sesja wygasła: pętla odświeżania się zatrzymuje

  const actions = createActions({
    store,
    markMoved: (id) => board.markMoved(id),
    onSettled: () => { refresh({ force: true }); },
  });
  const dialogs = createDialogs({ store, actions, openLink: session.openLink });
  const board = createBoard({ store, onOpen: (id) => dialogs.openTask(id, document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)) });

  function stop(kind) {
    ended = true;
    clearTimeout(timer);
    dialogs.closeAll();
    if (kind === 403) showDenied(config);
    else if (activity) showScreen({ title: 'Sesja wygasła', text: 'Zamknij Activity i uruchom je jeszcze raz.', error: true, buttons: [{ label: 'Odśwież', primary: true, onClick: reload }] });
    else showLogin(config, 'Sesja wygasła. Zaloguj się ponownie.');
  }

  async function loadPeople() {
    if (peopleLoading) return;
    peopleLoading = true;
    try {
      const { data } = await api('GET', '/api/people');
      lastPeopleAt = Date.now();
      store.applyPeople(data.people);
    } catch { /* lista osób jest dodatkiem: bez niej karty pokazują inicjały */ } finally { peopleLoading = false; }
  }

  function applyBoard(data, tag) {
    etag = tag;
    store.applyBoard(data);
    if (store.unknownAssignees().length && Date.now() - lastPeopleAt > 60000) loadPeople();
  }

  async function refresh({ force = false } = {}) {
    if (ended) return;
    if (loading) { if (force) rerun = true; return; } // wymuszone odświeżenie nie ginie, tylko rusza zaraz po bieżącym
    loading = true;
    const gen = actions.generation();
    try {
      const { status, data, etag: tag } = await api('GET', '/api/board', null, { etag: force ? null : etag });
      failures = 0;
      store.setOnline(true);
      if (status === 304) return;
      // Migawka wystartowała przed zmianą albo w jej trakcie, więc może być starsza niż ona: nie nadpisujemy nią tablicy.
      // Nowe pobranie zleca koniec zmiany (onSettled -> refresh z force), więc tu nie ponawiamy sami: przy długiej zmianie byłaby z tego pętla zapytań.
      if (actions.isBusy() || actions.generation() !== gen) return;
      if (drag && drag.isDragging()) { deferred = { data, tag }; return; }
      applyBoard(data, tag);
    } catch (err) {
      if (err.status === 401 || err.status === 403) { stop(err.status); return; }
      failures += 1;
      store.setOnline(false);
    } finally {
      loading = false;
      if (rerun && !ended) { rerun = false; refresh({ force: true }); }
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (ended) return;
    const wait = failures ? Math.min(30000, POLL_MS * 2 ** Math.min(failures, 2)) : POLL_MS;
    timer = setTimeout(async () => {
      if (!document.hidden) {
        await refresh();
        if (Date.now() - lastPeopleAt > PEOPLE_REFRESH_MS) loadPeople();
      }
      schedule();
    }, wait + Math.random() * 1000);
  }

  drag = createDrag({
    boardEl: board.boardEl,
    getTask: store.task,
    canDrag: store.canDrag,
    canDrop: store.canMove,
    onDrop: (task, status) => { actions.move(task, status).catch((err) => toast(err.message, 'error')); },
    onBlocked: (kind) => toast(kind === 'drag'
      ? 'Zadania w tym statusie zmienia kierownictwo lub moderacja.'
      : 'Ten status zmienia kierownictwo lub moderacja.', 'error'),
    onStart: () => {},
    onEnd: () => {
      if (deferred) { applyBoard(deferred.data, deferred.tag); deferred = null; }
      if (renderPending) { renderPending = false; board.render(); }
    },
  });

  // ---- powłoka strony
  const dot = h('span', { class: 'status-dot', text: 'Na żywo' });
  const filterButtons = FILTERS.map(([key, label]) => h('button', {
    type: 'button', 'aria-pressed': 'false', dataset: { filter: key }, text: label, onClick: () => store.setFilter(key),
  }));
  const newBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => dialogs.openNew(newBtn) },
    icon('plus'), h('span', { text: 'Nowe' }), h('span', { class: 'long', text: ' zadanie' }));
  const userChip = h('span', { class: 'user-chip' });
  const noteEl = h('p', { class: 'note', role: 'status', hidden: true });
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('h1', { text: 'Tablica redakcji' }), h('small', { text: 'GameBy.pl' })),
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Filtr zadań' }, ...filterButtons),
    dot, newBtn, userChip);
  const shell = h('div', { class: 'shell' }, topbar, noteEl, board.tabsEl, board.boardEl);

  function renderHeader() {
    const s = store.state;
    for (const b of filterButtons) b.setAttribute('aria-pressed', String(b.dataset.filter === s.filter));
    dot.className = `status-dot${s.online ? '' : ' offline'}`;
    dot.textContent = s.online ? 'Na żywo' : 'Brak połączenia, próbuję dalej';
    noteEl.hidden = !s.note;
    noteEl.textContent = s.note;
    clear(userChip);
    if (s.me) {
      userChip.append(avatarEl(s.people.get(s.me.id), s.me.id), s.me.name);
      if (!activity) userChip.append(h('button', { type: 'button', class: 'link-btn', text: 'Wyloguj', onClick: logout }));
    }
  }

  store.subscribe(() => {
    renderHeader();
    if (drag && drag.isDragging()) renderPending = true; // przebudowa kart w trakcie przeciągania zgubiłaby trzymaną kartę
    else board.render();
    dialogs.sync();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !ended) { refresh(); schedule(); }
  });

  // Pierwsze pobranie. Błąd tutaj oznacza brak sesji albo brak dostępu, więc zamiast pustej tablicy pokazujemy ekran z wyjaśnieniem.
  try {
    const first = await api('GET', '/api/board');
    const peopleReq = loadPeople();
    applyBoard(first.data, first.etag);
    await peopleReq;
    clear(app);
    app.append(shell);
  } catch (err) {
    if (err.status === 401 && !activity) showLogin(config);
    else if (err.status === 403) showDenied(config);
    else showScreen({ title: 'Nie udało się wczytać tablicy', text: err.message, error: true, buttons: [{ label: 'Spróbuj ponownie', primary: true, onClick: reload }] });
    return;
  }
  schedule();
}

boot();
