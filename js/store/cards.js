// store/cards.js — captured notes, unfiled until given an area. Takes the
// state as its first argument; store.js binds it to the live one.

import { uid } from '../util.js';

export const unfiledCards = (s) => s.cards.filter((c) => !c.areaId);
export const cardsForArea = (s, areaId) => s.cards.filter((c) => c.areaId === areaId);
export const cardById = (s, id) => s.cards.find((c) => c.id === id) || null;

/** Capture a note. Unfiled unless an area is named. */
export function addCard(s, text, { areaId = null } = {}) {
  const now = new Date().toISOString();
  const card = { id: uid('c'), text: text.trim(), areaId, createdAt: now, updatedAt: now };
  s.cards.unshift(card);
  return card;
}

export function updateCard(s, id, patch) {
  const c = cardById(s, id);
  if (c) Object.assign(c, patch, { updatedAt: new Date().toISOString() });
  return c;
}

export function deleteCard(s, id) {
  const i = s.cards.findIndex((c) => c.id === id);
  if (i >= 0) s.cards.splice(i, 1);
}
