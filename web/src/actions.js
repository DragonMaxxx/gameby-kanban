// Autor: Mateusz Bartoszewicz
// Zmiany zadań. Przeniesienie karty jest od razu widoczne (optymistycznie) i cofa się, jeśli bot odmówi; pozostałe akcje
// czekają na odpowiedź bota. Odpowiedź odświeżania, która wystartowała przed zmianą (albo w jej trakcie), jest odrzucana:
// generation() rośnie przy starcie i końcu każdej zmiany, więc strona wie, że taka migawka mogła być starsza niż zmiana.
import { api, ApiError } from './api.js';

export function createActions({ store, markMoved, onSettled }) {
  let inflight = 0;
  let generation = 0;

  async function mutate(fn) {
    inflight += 1;
    generation += 1;
    try {
      return await fn();
    } catch (err) {
      // Zadanie zniknęło z Discorda (usunięte, zarchiwizowane): niech tablica to nadrobi przy najbliższym odświeżeniu.
      if (err instanceof ApiError && err.status === 404) onSettled();
      throw err;
    } finally {
      inflight -= 1;
      generation += 1;
      if (inflight === 0) onSettled();
    }
  }

  const post = async (path, body) => {
    const { data } = await api('POST', path, body);
    store.replaceTask(data.task);
    return data.task;
  };

  return {
    isBusy: () => inflight > 0,
    generation: () => generation,
    move: (task, status) => mutate(async () => {
      const before = { ...task };
      store.replaceTask({ ...task, status });
      markMoved(task.id);
      try {
        const { data } = await api('POST', '/api/move', { id: task.id, status });
        store.replaceTask(data.task);
        return data.task;
      } catch (err) {
        store.replaceTask(before);
        throw err;
      }
    }),
    take: (task) => mutate(() => post('/api/take', { id: task.id })),
    release: (task) => mutate(() => post('/api/release', { id: task.id })),
    assign: (task, userId) => mutate(() => post('/api/assign', { id: task.id, userId })),
    // fields: { due } (oddanie tekstu) i/lub { pubDue } (publikacja); pusty tekst usuwa termin, brak pola zostawia go bez zmian
    due: (task, fields) => mutate(() => post('/api/due', { id: task.id, ...fields })),
    urgent: (task, urgent) => mutate(() => post('/api/urgent', { id: task.id, urgent: Boolean(urgent) })),
    // action: 'on' (zgłoś; zarząd zatwierdza od razu), 'ok' (zatwierdź, tylko zarząd), 'off' (cofnij zgłoszenie albo usuń premię); reguły sprawdza bot
    social: (task, action) => mutate(() => post('/api/social', { id: task.id, action })),
    create: (fields) => mutate(async () => {
      const task = await post('/api/task', fields);
      markMoved(task.id);
      store.state.tab = task.status;
      store.emit();
      return task;
    }),
  };
}
