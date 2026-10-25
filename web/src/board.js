// Autor: Mateusz Bartoszewicz
// Kolumny i karty. Kolumny są trwałymi elementami; karty przebudowujemy tylko w kolumnach, w których coś się zmieniło,
// dzięki temu przewijanie i fokus nie skaczą przy odświeżaniu co kilka sekund.
import { h, clear, icon } from './dom.js';
import { dueChips } from './format.js';
import { avatarEl, personName } from './people.js';

export function createBoard({ store, onOpen }) {
  const tabsEl = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Statusy' });
  const boardEl = h('main', { class: 'board', 'aria-label': 'Tablica zadań' });
  const columns = new Map(); // status -> {root, title, count, lock, list, sig}
  const tabs = new Map();
  let lastMoved = null;
  let lastTab = null;

  function ensureColumns(statuses) {
    const same = statuses.length === columns.size && statuses.every((s) => columns.has(s));
    if (same) return;
    clear(boardEl);
    clear(tabsEl);
    columns.clear();
    tabs.clear();
    for (const status of statuses) {
      const title = h('h2', { text: status });
      const count = h('span', { class: 'count' });
      const lock = h('span', { class: 'lock', hidden: true, title: 'Ten status zmienia kierownictwo lub moderacja' }, icon('lock'));
      const list = h('ul', { class: 'col-list', role: 'list' });
      const root = h('section', { class: 'col', dataset: { status, drop: status }, 'aria-label': status },
        h('header', { class: 'col-head' }, title, count, lock), list);
      boardEl.append(root);
      columns.set(status, { root, count, lock, list, sig: '' });
      const n = h('span', { class: 'n' });
      const tabLock = h('span', { class: 'lock', hidden: true, title: 'Ten status zmienia kierownictwo lub moderacja' }, icon('lock'));
      const tab = h('button', {
        type: 'button', class: 'tab', role: 'tab', dataset: { drop: status },
        onClick: () => { store.state.tab = status; lastTab = null; render(); },
      }, status, n, tabLock);
      tabsEl.append(tab);
      tabs.set(status, { tab, n, lock: tabLock });
    }
  }

  function cardEl(task, state) {
    const person = task.assigneeId ? state.people.get(task.assigneeId) : null;
    // Dwa terminy: oddanie tekstu i publikacja. Podczas pisania liczy się wcześniejszy, po oddaniu tekstu tylko publikacja
    // (bez niej plakietka „tekst oddany”, tylko tam, gdzie był termin), a opublikowane nie pokazują nic.
    const chips = dueChips(task, state.today, state.writingDone.has(task.status));
    const mine = state.me && task.assigneeId === state.me.id;
    const who = task.assigneeId
      ? h('span', { class: 'who' }, avatarEl(person, task.assigneeId), h('span', { text: personName(state, task.assigneeId) }))
      : h('span', { class: 'who', text: 'Bez osoby' });
    const label = [task.name, `Status: ${task.status}`, task.assigneeId ? `Osoba: ${personName(state, task.assigneeId)}` : 'Bez osoby',
      ...chips.map((c) => c.label), task.urgent ? 'Pilne' : null].filter(Boolean).join('. ');
    return h('li', {
      class: `card${task.urgent ? ' urgent' : ''}${mine ? ' mine' : ''}`, dataset: { id: task.id }, tabindex: '0', role: 'button', 'aria-label': label,
      onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(task.id); } },
    },
    h('span', { class: 'grip', title: 'Przeciągnij, żeby zmienić status' }, icon('grip')),
    h('div', { class: 'card-main' },
      h('div', { class: 'card-title', text: task.name }),
      h('div', { class: 'card-meta' },
        who,
        ...chips.map((c) => h('span', { class: `chip ${c.tone}`, text: c.text })),
        task.urgent ? h('span', { class: 'chip urgent', text: 'PILNE' }) : null)));
  }

  function render() {
    const state = store.state;
    if (!state.statuses.length) return;
    ensureColumns(state.statuses);
    const focusedId = document.activeElement && document.activeElement.closest ? (document.activeElement.closest('.card') || {}).dataset?.id : null;
    const filterActive = state.filter !== 'all';

    for (const status of state.statuses) {
      const col = columns.get(status);
      const all = state.tasks.filter((t) => t.status === status);
      const shown = all.filter((t) => store.visible(t));
      const sig = JSON.stringify([
        shown.map((t) => [t.id, t.name, t.assigneeId, t.due, t.pubDue, t.urgent, t.assigneeId ? [personName(state, t.assigneeId), Boolean((state.people.get(t.assigneeId) || {}).avatar)] : 0]),
        state.me && state.me.id, state.today, state.filter, status === 'Opublikowane' ? state.publishedTotal : 0,
      ]);
      col.count.textContent = String(shown.length);
      col.lock.hidden = !(state.me && !state.me.canManage && state.restricted.has(status));
      const tab = tabs.get(status);
      tab.n.textContent = String(shown.length);
      tab.lock.hidden = col.lock.hidden;
      const active = state.tab === status;
      col.root.classList.toggle('active', active);
      tab.tab.setAttribute('aria-selected', String(active));
      if (col.sig === sig) continue;
      col.sig = sig;
      clear(col.list);
      for (const task of shown) col.list.append(cardEl(task, state));
      if (!shown.length) col.list.append(h('li', { class: 'empty', text: filterActive ? 'Brak zadań dla tego filtru' : 'Brak zadań' }));
      if (status === 'Opublikowane' && !filterActive && state.publishedTotal > shown.length) {
        col.list.append(h('li', { class: 'more', text: `Pokazano ${shown.length} najnowszych z ${state.publishedTotal}` }));
      }
    }
    if (lastTab !== state.tab) {
      lastTab = state.tab;
      const t = tabs.get(state.tab);
      if (t && t.tab.scrollIntoView) t.tab.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
    if (focusedId && !(document.activeElement && document.activeElement.closest('.card'))) {
      const again = boardEl.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
    if (lastMoved) {
      const el = boardEl.querySelector(`.card[data-id="${CSS.escape(lastMoved)}"]`);
      if (el) { el.classList.add('just-moved'); setTimeout(() => el.classList.remove('just-moved'), 1500); }
      lastMoved = null;
    }
  }

  boardEl.addEventListener('click', (e) => {
    const card = e.target.closest ? e.target.closest('.card') : null;
    if (card) onOpen(card.dataset.id);
  });

  return {
    tabsEl, boardEl, render,
    markMoved(id) { lastMoved = id; },
  };
}
