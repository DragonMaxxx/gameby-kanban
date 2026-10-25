// Autor: Mateusz Bartoszewicz
// Stan tablicy w pamięci strony i reguły, które odzwierciedlają te z bota (bot i tak sprawdza wszystko jeszcze raz).
const FILTER_KEY = 'gb_filter';
export const FILTERS = [
  ['all', 'Wszystkie'],
  ['mine', 'Moje'],
  ['urgent', 'Pilne'],
  ['free', 'Bez osoby'],
];

function loadFilter() {
  try {
    const v = window.localStorage.getItem(FILTER_KEY);
    return FILTERS.some(([k]) => k === v) ? v : 'all';
  } catch { return 'all'; }
}

export function createStore() {
  const subs = new Set();
  const state = {
    me: null, // {id, name, canManage}
    statuses: [],
    restricted: new Set(),
    writingDone: new Set(), // statusy, od których termin przestaje się liczyć (tekst oddany)
    tasks: [],
    today: '',
    publishedTotal: 0,
    note: '',
    people: new Map(), // id -> {id, name, avatar}
    filter: loadFilter(),
    tab: null, // aktywna zakładka w wąskim układzie
    online: true,
    activity: false,
  };

  const store = {
    state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit() { for (const fn of subs) fn(state); },
    task: (id) => state.tasks.find((t) => t.id === id) || null,
    setFilter(f) {
      state.filter = f;
      try { window.localStorage.setItem(FILTER_KEY, f); } catch { /* pamięć przeglądarki bywa zablokowana, filtr działa dalej */ }
      store.emit();
    },
    // Wynik /api/board. Zwraca numery osób przypisanych do zadań, których nie znamy z listy osób.
    applyBoard(data) {
      state.me = data.me;
      state.statuses = data.statuses;
      state.restricted = new Set(data.restricted);
      state.writingDone = new Set(data.writingDone || []);
      state.tasks = data.tasks;
      state.today = data.today;
      state.publishedTotal = data.publishedTotal || 0;
      state.note = data.note || '';
      if (!state.tab || !state.statuses.includes(state.tab)) state.tab = state.statuses[0];
      store.emit();
    },
    applyPeople(list) {
      state.people = new Map(list.map((p) => [p.id, p]));
      store.emit();
    },
    unknownAssignees() {
      return [...new Set(state.tasks.map((t) => t.assigneeId).filter((id) => id && !state.people.has(id)))];
    },
    replaceTask(task) {
      const i = state.tasks.findIndex((t) => t.id === task.id);
      if (i >= 0) state.tasks[i] = task;
      else state.tasks.push(task);
      store.emit();
    },
    removeTask(id) {
      state.tasks = state.tasks.filter((t) => t.id !== id);
      store.emit();
    },
    setOnline(v) {
      if (state.online !== v) { state.online = v; store.emit(); }
    },
    visible(task) {
      switch (state.filter) {
        case 'mine': return Boolean(state.me) && task.assigneeId === state.me.id;
        case 'urgent': return task.urgent;
        case 'free': return !task.assigneeId;
        default: return true;
      }
    },
    // Statusy „Do publikacji” i „Opublikowane” (także wyjście z nich) zmienia tylko kierownictwo lub moderacja.
    canMove(task, to) {
      if (!state.me) return false;
      if (state.me.canManage) return true;
      return !state.restricted.has(task.status) && !state.restricted.has(to);
    },
    canDrag(task) {
      return Boolean(state.me) && (state.me.canManage || !state.restricted.has(task.status));
    },
  };
  return store;
}
