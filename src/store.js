'use strict';
// Autor: Mateusz Bartoszewicz
// Minimalny stan na dysku (kiedy wysłano ostatnie podsumowanie), żeby po restarcie bot nie wysłał go drugi raz.
const fs = require('node:fs');
const path = require('node:path');

// seed: stan z innego hostingu (obiekt). Używany tylko wtedy, gdy pliku stanu jeszcze nie ma, więc zostawiony w ustawieniach
// niczego nie nadpisze przy kolejnych startach. Zwraca info, czy go użyto.
function createStore(file, { seed = null, log = console } = {}) {
  let data = {};
  let seeded = false;
  const exists = fs.existsSync(file);
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  if (seed && !exists) {
    data = { ...seed };
    try { persist(); seeded = true; log.log(`Wczytano stan początkowy z ustawienia STATE_SEED_B64 do ${file}. Możesz już usunąć to ustawienie.`); } catch (err) {
      log.error(`Nie mogę zapisać stanu początkowego w ${file}: ${err.message}`);
    }
  } else if (seed) {
    log.log(`Plik stanu ${file} już istnieje, więc STATE_SEED_B64 jest pomijane (możesz usunąć to ustawienie).`);
  }
  return {
    get: (key) => data[key],
    set(key, value) {
      data[key] = value;
      try { persist(); } catch (err) {
        console.error(`Nie mogę zapisać stanu w ${file}: ${err.message}`);
      }
    },
    seeded,
  };
}

module.exports = { createStore };
