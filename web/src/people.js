// Autor: Mateusz Bartoszewicz
import { h } from './dom.js';
import { hueOf, initials } from './format.js';

// Zdjęcie osoby (data: URI z serwera) albo kółko z inicjałami, gdy zdjęcia nie ma.
export function avatarEl(person, id, big = false) {
  const size = big ? ' big' : '';
  if (person && person.avatar) {
    return h('img', { class: `avatar${size}`, src: person.avatar, alt: '', draggable: 'false' });
  }
  const el = h('span', { class: `avatar ph${size}`, 'aria-hidden': 'true', text: initials(person ? person.name : '?') });
  el.style.setProperty('--ph', `hsl(${hueOf(id)} 45% 42%)`);
  return el;
}

export const personName = (state, id) => {
  const p = state.people.get(id);
  if (p) return p.name;
  return state.me && state.me.id === id ? state.me.name : 'Osoba spoza listy';
};
