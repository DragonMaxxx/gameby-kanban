// Autor: Mateusz Bartoszewicz
// Przeciąganie kart na zdarzeniach wskaźnika (mysz, rysik, dotyk), bez bibliotek.
//  - mysz i rysik: przeciąganie zaczyna się po przesunięciu o kilka pikseli, więc zwykłe kliknięcie nadal otwiera kartę;
//  - dotyk: za uchwyt po lewej (przeciąganie od razu, bez przewijania) albo po długim przytrzymaniu karty (około 0,35 s).
//    Zanim minie ten czas, ruch palca przewija listę jak zwykle;
//  - Esc albo przerwanie wskaźnika (np. połączenie, które zabiera system) anuluje przeciąganie bez zmiany statusu.
const LONG_PRESS_MS = 350;
const PRESS_TOLERANCE_PX = 10;
const MOUSE_THRESHOLD_PX = 5;
const GRIP_THRESHOLD_PX = 4;
const EDGE_PX = 56;
const MAX_SCROLL_PX = 18;
const CLICK_SUPPRESS_MS = 450;

export function createDrag({ boardEl, getTask, canDrag, canDrop, onDrop, onBlocked, onStart, onEnd }) {
  let pending = null; // wskaźnik wciśnięty na karcie, ale przeciąganie jeszcze się nie zaczęło
  let drag = null;
  // Kliknięcie generowane po puszczeniu przycisku ma być zignorowane tylko na karcie, którą przeciągano (nie na innych).
  let suppress = { el: null, until: 0 };

  const now = () => performance.now();

  function cancelPending() {
    if (pending && pending.timer) clearTimeout(pending.timer);
    pending = null;
  }

  function begin() {
    if (!pending) return;
    const p = pending;
    cancelPending();
    const task = getTask(p.id);
    if (!task || !p.el.isConnected) return;
    if (!canDrag(task)) {
      // Kliknięcie, które przyjdzie po puszczeniu przycisku, nie ma otwierać karty po nieudanej próbie przeciągnięcia.
      suppress = { el: p.el, until: Infinity };
      const release = () => { suppress = { el: p.el, until: now() + CLICK_SUPPRESS_MS }; };
      window.addEventListener('pointerup', release, { once: true });
      window.addEventListener('pointercancel', release, { once: true });
      onBlocked('drag', task);
      return;
    }
    const rect = p.el.getBoundingClientRect();
    const ghost = p.el.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.classList.remove('drag-source', 'just-moved');
    ghost.removeAttribute('tabindex');
    ghost.removeAttribute('data-id');
    ghost.removeAttribute('role');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    document.body.append(ghost);
    p.el.classList.add('drag-source');
    document.body.classList.add('is-dragging');
    try { p.el.setPointerCapture(p.pointerId); } catch { /* pewne przeglądarki odmawiają przechwycenia; zdarzenia i tak dochodzą do okna */ }
    if (p.type === 'touch' && navigator.vibrate) { try { navigator.vibrate(12); } catch { /* wibracja jest dodatkiem */ } }
    drag = { task, el: p.el, ghost, pointerId: p.pointerId, offX: p.x - rect.left, offY: p.y - rect.top, x: p.x, y: p.y, over: null, raf: 0 };
    onStart(task);
    drag.raf = requestAnimationFrame(loop);
  }

  function setOver(target) {
    if (drag.over === target) return;
    if (drag.over) drag.over.classList.remove('drop-ok', 'drop-no');
    drag.over = target;
    if (!target) return;
    const status = target.dataset.drop;
    if (status === drag.task.status) return; // z powrotem do tej samej kolumny: bez podświetlenia
    target.classList.add(canDrop(drag.task, status) ? 'drop-ok' : 'drop-no');
  }

  function autoScroll() {
    const b = boardEl.getBoundingClientRect();
    const speed = (dist) => Math.ceil(MAX_SCROLL_PX * Math.min(1, (EDGE_PX - dist) / EDGE_PX));
    if (drag.x < b.left + EDGE_PX) boardEl.scrollLeft -= speed(drag.x - b.left);
    else if (drag.x > b.right - EDGE_PX) boardEl.scrollLeft += speed(b.right - drag.x);
    const hit = document.elementFromPoint(drag.x, drag.y);
    const list = hit && hit.closest ? hit.closest('.col') : null;
    const scroller = list ? list.querySelector('.col-list') : null;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (drag.y < r.top + EDGE_PX) scroller.scrollTop -= speed(Math.max(0, drag.y - r.top));
      else if (drag.y > r.bottom - EDGE_PX) scroller.scrollTop += speed(Math.max(0, r.bottom - drag.y));
    }
  }

  function loop() {
    if (!drag) return;
    drag.ghost.style.transform = `translate3d(${drag.x - drag.offX}px, ${drag.y - drag.offY}px, 0) rotate(1.5deg)`;
    const hit = document.elementFromPoint(drag.x, drag.y);
    setOver(hit && hit.closest ? hit.closest('[data-drop]') : null);
    autoScroll();
    drag.raf = requestAnimationFrame(loop);
  }

  function finish(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    const target = d.over;
    if (target) target.classList.remove('drop-ok', 'drop-no');
    d.ghost.remove();
    d.el.classList.remove('drag-source');
    document.body.classList.remove('is-dragging');
    try { d.el.releasePointerCapture(d.pointerId); } catch { /* już zwolnione */ }
    suppress = { el: d.el, until: now() + CLICK_SUPPRESS_MS };
    onEnd();
    const status = target ? target.dataset.drop : null;
    if (commit && status && status !== d.task.status) {
      if (canDrop(d.task, status)) onDrop(d.task, status);
      else onBlocked('drop', d.task, status);
    }
  }

  function onDown(e) {
    if (drag || pending) return;
    const el = e.target.closest ? e.target.closest('.card') : null;
    if (!el) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pending = {
      el, id: el.dataset.id, pointerId: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      grip: Boolean(e.target.closest('.grip')), timer: null,
    };
    if (pending.type === 'touch' && !pending.grip) pending.timer = setTimeout(begin, LONG_PRESS_MS);
  }

  function onMove(e) {
    if (drag && e.pointerId === drag.pointerId) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    if (!pending || e.pointerId !== pending.pointerId) return;
    pending.x = e.clientX;
    pending.y = e.clientY;
    const dist = Math.hypot(e.clientX - pending.x0, e.clientY - pending.y0);
    if (pending.type === 'touch') {
      if (pending.grip) { if (dist >= GRIP_THRESHOLD_PX) begin(); }
      else if (dist > PRESS_TOLERANCE_PX) cancelPending(); // palec przewija listę
    } else if (dist >= MOUSE_THRESHOLD_PX) begin();
  }

  function onUp(e) {
    if (drag && e.pointerId === drag.pointerId) { finish(true); return; }
    if (pending && e.pointerId === pending.pointerId) cancelPending();
  }

  function onCancel(e) {
    if (drag && e.pointerId === drag.pointerId) finish(false);
    else if (pending && e.pointerId === pending.pointerId) cancelPending();
  }

  // Po uzbrojeniu przeciągania przeglądarka nie może zacząć przewijania strony pod palcem.
  function onTouchMove(e) {
    if (drag && e.cancelable) e.preventDefault();
  }

  boardEl.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  boardEl.addEventListener('dragstart', (e) => e.preventDefault());
  boardEl.addEventListener('contextmenu', (e) => { if (pending || drag || now() < suppress.until) e.preventDefault(); });
  // Zwolnienie przycisku po przeciąganiu generuje kliknięcie; bez tego każde przeciągnięcie otwierałoby okno karty.
  boardEl.addEventListener('click', (e) => {
    const card = e.target.closest ? e.target.closest('.card') : null;
    if (card && card === suppress.el && now() < suppress.until) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) { e.preventDefault(); finish(false); } });
  window.addEventListener('blur', () => { cancelPending(); finish(false); });

  return { isDragging: () => Boolean(drag) };
}
