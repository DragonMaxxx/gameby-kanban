// Autor: Mateusz Bartoszewicz
// Okno zadania (status, osoba, termin, pilne) i okno nowego zadania. Każda akcja idzie do bota, który sprawdza uprawnienia jeszcze raz.
import { h, clear, append, icon, toast } from './dom.js';
import { safeDiscordUrl } from './format.js';
import { avatarEl, personName } from './people.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Wspólna otoczka: tło, rola dialogu, pułapka fokusu, Esc i zamykanie kliknięciem w tło.
function modal({ labelId, content, onClose }) {
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId }, content);
  const overlay = h('div', { class: 'overlay' }, sheet);
  let downOnOverlay = false;
  overlay.addEventListener('pointerdown', (e) => { downOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (downOnOverlay && e.target === overlay) onClose(); downOnOverlay = false; });
  // Klawisze obsługujemy na poziomie dokumentu: fokus potrafi chwilowo trafić na <body> (np. gdy przycisk zniknie po odświeżeniu),
  // a Esc nadal ma zamykać okno, i Tab nie może uciec spod okna na tablicę.
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  return { overlay, sheet, destroy: () => document.removeEventListener('keydown', onKey, true) };
}

function personSelect(state, selectedId, { id }) {
  const select = h('select', { id });
  select.append(h('option', { value: '', text: '— nikt —' }));
  const ids = new Set();
  for (const p of state.people.values()) { select.append(h('option', { value: p.id, text: p.name })); ids.add(p.id); }
  if (selectedId && !ids.has(selectedId)) select.append(h('option', { value: selectedId, text: personName(state, selectedId) }));
  select.value = selectedId || '';
  return select;
}

export function createDialogs({ store, actions, openLink }) {
  let current = null; // {task id, opener, ...}

  // ------------------------------------------------------------ okno zadania
  function openTask(taskId, opener) {
    if (current) closeAll();
    const task = store.task(taskId);
    if (!task) return;
    let busy = false;
    let dueDirty = false;
    let pubDirty = false;

    const title = h('h2', { id: 'sheet-title' });
    const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Zamknij', onClick: closeAll }, icon('close'));
    const link = h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Otwórz post w Discordzie');
    link.addEventListener('click', (e) => {
      if (!openLink) return;
      e.preventDefault();
      openLink(link.href);
    });

    const statusButtons = new Map();
    const statusGrid = h('div', { class: 'status-grid' });
    for (const status of store.state.statuses) {
      const b = h('button', {
        type: 'button', class: 'status-btn', dataset: { status }, text: status,
        onClick: () => run(() => {
          const t = store.task(taskId);
          if (!t || t.status === status) return null;
          if (!store.canMove(t, status)) { toast('Ten status zmienia kierownictwo lub moderacja.', 'error'); return null; }
          return actions.move(t, status);
        }),
      });
      statusButtons.set(status, b);
      statusGrid.append(b);
    }
    const statusHint = h('p', { class: 'hint', text: 'Statusy „Do publikacji” i „Opublikowane” zmienia kierownictwo lub moderacja.' });

    const whoLine = h('div', { class: 'who-line' });
    const takeBtn = h('button', { type: 'button', class: 'btn primary', text: 'Biorę to', onClick: () => run(() => actions.take(store.task(taskId))) });
    const releaseBtn = h('button', { type: 'button', class: 'btn', text: 'Zwolnij', onClick: () => run(() => actions.release(store.task(taskId))) });
    const peopleSig = (state, assigneeId) => `${[...state.people.keys()].join(',')}|${assigneeId || ''}`;
    let select = personSelect(store.state, task.assigneeId, { id: 'assign-select' });
    select.dataset.sig = peopleSig(store.state, task.assigneeId);
    const selectWrap = h('div', { class: 'row' });
    const bindSelect = (el) => el.addEventListener('change', () => run(() => actions.assign(store.task(taskId), el.value || null)));
    bindSelect(select);
    selectWrap.append(select);

    const dueInput = h('input', { type: 'date', id: 'due-input', 'aria-label': 'Termin oddania tekstu', placeholder: 'RRRR-MM-DD', maxLength: 10 });
    dueInput.addEventListener('input', () => { dueDirty = true; });
    const dueSave = h('button', { type: 'button', class: 'btn', text: 'Zapisz termin', onClick: () => run(async () => {
      const r = await actions.due(store.task(taskId), { due: dueInput.value });
      dueDirty = false;
      return r;
    }) });
    const dueClear = h('button', { type: 'button', class: 'btn', text: 'Usuń termin', onClick: () => run(async () => {
      dueInput.value = '';
      const r = await actions.due(store.task(taskId), { due: '' });
      dueDirty = false;
      return r;
    }) });

    // Termin publikacji (premiera, embargo) jest osobny: nie znika po oddaniu tekstu, tylko zaczyna się liczyć sam.
    const pubInput = h('input', { type: 'date', id: 'pub-input', 'aria-label': 'Termin publikacji', placeholder: 'RRRR-MM-DD', maxLength: 10 });
    pubInput.addEventListener('input', () => { pubDirty = true; });
    const pubSave = h('button', { type: 'button', class: 'btn', text: 'Zapisz publikację', onClick: () => run(async () => {
      const r = await actions.due(store.task(taskId), { pubDue: pubInput.value });
      pubDirty = false;
      return r;
    }) });
    const pubClear = h('button', { type: 'button', class: 'btn', text: 'Usuń publikację', onClick: () => run(async () => {
      pubInput.value = '';
      const r = await actions.due(store.task(taskId), { pubDue: '' });
      pubDirty = false;
      return r;
    }) });

    const urgent = h('input', { type: 'checkbox', id: 'urgent-input' });
    urgent.addEventListener('change', () => run(() => actions.urgent(store.task(taskId), urgent.checked)));

    const content = [
      h('div', { class: 'sheet-head' }, title, closeBtn),
      h('div', { class: 'row' }, link),
      h('div', { class: 'field' }, h('span', { class: 'label', id: 'status-label', text: 'Status' }), statusGrid, statusHint),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Osoba' }), whoLine,
        h('div', { class: 'row' }, takeBtn, releaseBtn), h('div', { class: 'row' }, h('label', { for: 'assign-select', class: 'hint', text: 'Przydziel komuś innemu:' })), selectWrap),
      h('div', { class: 'field' }, h('label', { for: 'due-input', text: 'Termin oddania tekstu' }), h('div', { class: 'row' }, dueInput, dueSave, dueClear)),
      h('div', { class: 'field' }, h('label', { for: 'pub-input', text: 'Termin publikacji' }), h('div', { class: 'row' }, pubInput, pubSave, pubClear),
        h('p', { class: 'hint', text: 'Np. premiera lub embargo. Po oddaniu tekstu liczy się już tylko ten termin.' })),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Priorytet' }), h('label', { class: 'switch', for: 'urgent-input' }, urgent, 'Pilne')),
    ];
    const m = modal({ labelId: 'sheet-title', content, onClose: closeAll });

    async function run(fn) {
      if (busy) return;
      busy = true;
      sync();
      try {
        const result = fn();
        if (result) await result;
      } catch (err) {
        toast(err && err.message ? err.message : 'Coś poszło nie tak.', 'error');
      } finally {
        busy = false;
        if (current && current.taskId === taskId) {
          sync();
          // Lista osób ma pokazywać stan z serwera także wtedy, gdy ma fokus (po nieudanym przydziale zostałaby na osobie, która go nie dostała).
          const now = store.task(taskId);
          if (now && select.value !== (now.assigneeId || '')) select.value = now.assigneeId || '';
        }
      }
    }

    function sync() {
      const t = store.task(taskId);
      if (!t) { closeAll(); toast('To zadanie zostało usunięte, zarchiwizowane albo przeniesione poza tablicę.'); return; }
      const state = store.state;
      title.textContent = t.name;
      const url = safeDiscordUrl(t.url);
      link.hidden = !url;
      if (url) link.href = url;
      for (const [status, b] of statusButtons) {
        b.setAttribute('aria-pressed', String(t.status === status));
        b.disabled = t.status !== status && !store.canMove(t, status);
      }
      statusHint.hidden = Boolean(state.me && state.me.canManage);
      clear(whoLine);
      append(whoLine, [
        t.assigneeId ? avatarEl(state.people.get(t.assigneeId), t.assigneeId, true) : null,
        h('span', { text: t.assigneeId ? personName(state, t.assigneeId) : 'Nikt jeszcze nie wziął tego zadania' }),
      ]);
      const mine = Boolean(state.me) && t.assigneeId === state.me.id;
      takeBtn.hidden = Boolean(t.assigneeId);
      releaseBtn.hidden = !mine;
      const wanted = peopleSig(state, t.assigneeId);
      if (select.dataset.sig !== wanted && document.activeElement !== select) {
        const fresh = personSelect(state, t.assigneeId, { id: 'assign-select' });
        fresh.dataset.sig = wanted;
        bindSelect(fresh);
        select.replaceWith(fresh);
        select = fresh;
      } else if (document.activeElement !== select && !busy) {
        select.value = t.assigneeId || '';
      }
      if (!dueDirty && document.activeElement !== dueInput) dueInput.value = t.due || '';
      dueClear.hidden = !t.due;
      if (!pubDirty && document.activeElement !== pubInput) pubInput.value = t.pubDue || '';
      pubClear.hidden = !t.pubDue;
      // W trakcie zapisu zostawiamy to, co wybrała osoba; po odpowiedzi bota (albo błędzie) wraca stan z serwera.
      if (!busy) urgent.checked = t.urgent;
      m.sheet.setAttribute('aria-busy', String(busy));
    }

    current = { taskId, opener, overlay: m.overlay, sync, destroy: m.destroy };
    sync();
    closeBtn.focus();
  }

  // ------------------------------------------------------------ nowe zadanie
  function openNew(opener) {
    if (current) closeAll();
    let busy = false;
    const state = store.state;
    const titleInput = h('input', { type: 'text', id: 'new-title', maxLength: 100, required: true, autocomplete: 'off', placeholder: 'np. Recenzja nowego Zeldy' });
    const person = personSelect(state, '', { id: 'new-person' });
    const due = h('input', { type: 'date', id: 'new-due', placeholder: 'RRRR-MM-DD', maxLength: 10 });
    const pubDue = h('input', { type: 'date', id: 'new-pubdue', placeholder: 'RRRR-MM-DD', maxLength: 10 });
    const desc = h('textarea', { id: 'new-desc', maxLength: 1500, placeholder: 'Opcjonalnie: źródła, wytyczne, linki' });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn primary', text: 'Dodaj zadanie' });
    const cancel = h('button', { type: 'button', class: 'btn', text: 'Anuluj', onClick: closeAll });
    const form = h('form', { novalidate: true },
      h('div', { class: 'sheet-head' }, h('h2', { id: 'new-heading', text: 'Nowe zadanie' }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Zamknij', onClick: closeAll }, icon('close'))),
      h('div', { class: 'field' }, h('label', { for: 'new-title', text: 'Tytuł' }), titleInput),
      h('div', { class: 'field' }, h('label', { for: 'new-person', text: 'Osoba (opcjonalnie)' }), person),
      h('div', { class: 'field' }, h('label', { for: 'new-due', text: 'Termin oddania tekstu (opcjonalnie)' }), due),
      h('div', { class: 'field' }, h('label', { for: 'new-pubdue', text: 'Termin publikacji (opcjonalnie)' }), pubDue),
      h('div', { class: 'field' }, h('label', { for: 'new-desc', text: 'Opis (opcjonalnie)' }), desc),
      error,
      h('div', { class: 'actions' }, cancel, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const text = titleInput.value.trim();
      if (!text) { error.textContent = 'Podaj tytuł zadania.'; error.hidden = false; titleInput.focus(); return; }
      busy = true;
      form.setAttribute('aria-busy', 'true');
      error.hidden = true;
      try {
        await actions.create({ title: text, userId: person.value || null, due: due.value, pubDue: pubDue.value, description: desc.value.trim() });
        closeAll();
        toast('Dodano zadanie.');
      } catch (err) {
        error.textContent = err && err.message ? err.message : 'Nie udało się dodać zadania.';
        error.hidden = false;
      } finally {
        busy = false;
        form.removeAttribute('aria-busy');
      }
    });
    const m = modal({ labelId: 'new-heading', content: [form], onClose: closeAll });
    current = { taskId: null, opener, overlay: m.overlay, sync: () => {}, destroy: m.destroy };
    titleInput.focus();
  }

  function closeAll() {
    if (!current) return;
    const { overlay, opener, destroy } = current;
    current = null;
    destroy();
    overlay.remove();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  }

  return {
    openTask, openNew, closeAll,
    sync: () => { if (current) current.sync(); },
    isOpen: () => Boolean(current),
  };
}
