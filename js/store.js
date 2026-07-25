// store.js — Datenmodell, lokale Speicherung, Altersberechnung
"use strict";

const DB_KEY = "pg_db_v1";
const SETTINGS_KEY = "pg_settings_v1";

export const Store = {
  db: { version: 1, updatedAt: null, persons: [] },
  listeners: [],

  load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) this.db = JSON.parse(raw);
    } catch (e) { console.error("DB laden fehlgeschlagen", e); }
    this.migrate();
    return this.db;
  },

  // Ältere Datenstände um neue Felder ergänzen
  migrate() {
    if (!Array.isArray(this.db.relations)) this.db.relations = [];
    for (const p of this.db.persons) {
      if (p.company === undefined) p.company = "";
      if (p.position === undefined) p.position = "";
    }
  },

  save(markDirty = true) {
    if (markDirty) this.db.updatedAt = new Date().toISOString();
    localStorage.setItem(DB_KEY, JSON.stringify(this.db));
    this.listeners.forEach(fn => fn(this.db, markDirty));
  },

  onChange(fn) { this.listeners.push(fn); },

  replaceDb(newDb) {
    this.db = newDb;
    this.migrate();
    this.save(false);
  },

  // ---------- Personen ----------

  newId() { return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); },

  createPerson({ firstName, lastName = "", birthDate = null, birthYear = null, ageYears = null, estimated = false, company = "", position = "" }) {
    const birth = normalizeBirth({ birthDate, birthYear, ageYears, estimated });
    const p = {
      id: this.newId(),
      firstName: (firstName || "").trim(),
      lastName: (lastName || "").trim(),
      birth,
      company: (company || "").trim(),
      position: (position || "").trim(),
      partnerId: null,
      parentIds: [],
      notes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.db.persons.push(p);
    this.save();
    return p;
  },

  updatePerson(id, fields) {
    const p = this.get(id);
    if (!p) return null;
    if (fields.firstName !== undefined) p.firstName = fields.firstName.trim();
    if (fields.lastName !== undefined) p.lastName = fields.lastName.trim();
    if (fields.company !== undefined) p.company = (fields.company || "").trim();
    if (fields.position !== undefined) p.position = (fields.position || "").trim();
    if (fields.birthDate !== undefined || fields.birthYear !== undefined || fields.ageYears !== undefined) {
      p.birth = normalizeBirth({
        birthDate: fields.birthDate ?? null,
        birthYear: fields.birthYear ?? null,
        ageYears: fields.ageYears ?? null,
        estimated: fields.estimated ?? false,
      }) || p.birth;
    }
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  },

  deletePerson(id) {
    this.db.persons = this.db.persons.filter(p => p.id !== id);
    // Verweise aufräumen
    for (const p of this.db.persons) {
      if (p.partnerId === id) p.partnerId = null;
      p.parentIds = p.parentIds.filter(pid => pid !== id);
    }
    this.db.relations = this.db.relations.filter(r => r.fromId !== id && r.toId !== id);
    this.save();
  },

  get(id) { return this.db.persons.find(p => p.id === id) || null; },

  all() {
    return [...this.db.persons].sort((a, b) =>
      (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName, "de"));
  },

  // ---------- Beziehungen ----------

  setPartner(aId, bId) {
    const a = this.get(aId), b = this.get(bId);
    if (!a || !b) return;
    // Alte Partnerschaften lösen
    if (a.partnerId) { const old = this.get(a.partnerId); if (old) old.partnerId = null; }
    if (b.partnerId) { const old = this.get(b.partnerId); if (old) old.partnerId = null; }
    a.partnerId = bId;
    b.partnerId = aId;
    this.save();
  },

  removePartner(aId) {
    const a = this.get(aId);
    if (!a || !a.partnerId) return;
    const b = this.get(a.partnerId);
    if (b) b.partnerId = null;
    a.partnerId = null;
    this.save();
  },

  addParentChild(parentId, childId) {
    const child = this.get(childId);
    if (!child || parentId === childId) return;
    if (!child.parentIds.includes(parentId)) {
      child.parentIds.push(parentId);
      this.save();
    }
  },

  childrenOf(id) {
    return this.db.persons.filter(p => p.parentIds.includes(id));
  },

  partnerOf(id) {
    const p = this.get(id);
    return p && p.partnerId ? this.get(p.partnerId) : null;
  },

  parentsOf(id) {
    const p = this.get(id);
    return p ? p.parentIds.map(pid => this.get(pid)).filter(Boolean) : [];
  },

  // Abgeleitet: Eltern der Eltern
  grandparentsOf(id) {
    const result = new Map();
    for (const parent of this.parentsOf(id))
      for (const gp of this.parentsOf(parent.id))
        result.set(gp.id, gp);
    return [...result.values()];
  },

  // Abgeleitet: Kinder der Kinder
  grandchildrenOf(id) {
    const result = new Map();
    for (const child of this.childrenOf(id))
      for (const gc of this.childrenOf(child.id))
        result.set(gc.id, gc);
    return [...result.values()];
  },

  // ---------- Freie Beziehungen („from ist LABEL von to") ----------

  addRelation(fromId, toId, label) {
    const clean = (label || "").trim();
    if (!clean || !this.get(fromId) || !this.get(toId) || fromId === toId) return null;
    const exists = this.db.relations.find(r =>
      r.fromId === fromId && r.toId === toId && r.label.toLowerCase() === clean.toLowerCase());
    if (exists) return exists;
    const rel = { id: this.newId(), fromId, toId, label: clean };
    this.db.relations.push(rel);
    this.save();
    return rel;
  },

  removeRelation(relId) {
    this.db.relations = this.db.relations.filter(r => r.id !== relId);
    this.save();
  },

  // Beide Richtungen: outgoing = „Person ist X von …", incoming = „… ist X von Person"
  relationsFor(id) {
    const outgoing = this.db.relations
      .filter(r => r.fromId === id)
      .map(r => ({ rel: r, other: this.get(r.toId) }))
      .filter(x => x.other);
    const incoming = this.db.relations
      .filter(r => r.toId === id)
      .map(r => ({ rel: r, other: this.get(r.fromId) }))
      .filter(x => x.other);
    return { outgoing, incoming };
  },

  // ---------- Notizen ----------

  addNote(personId, text) {
    const p = this.get(personId);
    if (!p) return null;
    const note = { id: this.newId(), date: new Date().toISOString(), text: text.trim() };
    p.notes.push(note);
    p.updatedAt = new Date().toISOString();
    this.save();
    return note;
  },

  deleteNote(personId, noteId) {
    const p = this.get(personId);
    if (!p) return;
    p.notes = p.notes.filter(n => n.id !== noteId);
    this.save();
  },

  // ---------- Namenssuche ----------

  findByName(query) {
    if (!query) return [];
    const q = norm(query);
    const scored = [];
    for (const p of this.db.persons) {
      const first = norm(p.firstName), last = norm(p.lastName);
      const full = (first + " " + last).trim();
      let score = 0;
      if (full === q) score = 100;
      else if (first === q || (last && last === q)) score = 80;
      else if (full.startsWith(q) || q.startsWith(full)) score = 60;
      else if (first.startsWith(q) || (last && last.startsWith(q))) score = 50;
      else if (full.includes(q)) score = 30;
      if (score) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.p);
  },
};

function norm(s) {
  return (s || "").toLowerCase().trim()
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
    .replace(/\s+/g, " ");
}

// birth: { date: "YYYY-MM-DD"|null, year: number|null, estimated: bool }
function normalizeBirth({ birthDate, birthYear, ageYears, estimated }) {
  if (birthDate) {
    const d = String(birthDate).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: d, year: Number(d.slice(0, 4)), estimated: false };
  }
  if (birthYear) {
    const y = Number(birthYear);
    if (y > 1880 && y <= new Date().getFullYear()) return { date: null, year: y, estimated: !!estimated };
  }
  if (ageYears !== null && ageYears !== undefined && ageYears !== "") {
    const a = Number(ageYears);
    if (a >= 0 && a < 130) return { date: null, year: new Date().getFullYear() - a, estimated: true };
  }
  return null;
}

export function ageOf(person) {
  const b = person.birth;
  if (!b) return null;
  const now = new Date();
  if (b.date) {
    const d = new Date(b.date + "T00:00:00");
    let age = now.getFullYear() - d.getFullYear();
    const hadBirthday = (now.getMonth() > d.getMonth()) ||
      (now.getMonth() === d.getMonth() && now.getDate() >= d.getDate());
    if (!hadBirthday) age--;
    return { years: age, estimated: false };
  }
  if (b.year) return { years: now.getFullYear() - b.year, estimated: b.estimated };
  return null;
}

export function ageText(person) {
  const a = ageOf(person);
  if (!a) return "Alter unbekannt";
  return a.estimated ? `ca. ${a.years} Jahre` : `${a.years} Jahre`;
}

export function fullName(p) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ");
}

// ---------- Einstellungen ----------

export const Settings = {
  data: { googleClientId: "", anthropicKey: "", ttsEnabled: true, driveFileId: "" },
  load() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* ignorieren */ }
    return this.data;
  },
  save() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.data)); },
  set(key, value) { this.data[key] = value; this.save(); },
};
