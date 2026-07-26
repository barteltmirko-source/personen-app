// store.js — Datenmodell, lokale Speicherung, Altersberechnung
"use strict";

const DB_KEY = "pg_db_v1";
const SETTINGS_KEY = "pg_settings_v1";

// Fester Auffang-Tag: kann nicht gelöscht werden, fängt Personen ohne Zuordnung auf
export const UNSORTED_TAG_ID = "t_unsortiert";

const DEFAULT_TAGS = [
  { id: UNSORTED_TAG_ID, name: "Unsortiert" },
  { id: "t_familie1", name: "Familie 1. Grad" },
  { id: "t_familie2", name: "Familie 2. Grad" },
  { id: "t_freunde", name: "Freunde" },
  { id: "t_bekannte", name: "Bekannte" },
  { id: "t_arbeit", name: "Arbeit" },
];

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

  // Ältere Datenstände um neue Felder ergänzen. Ergänzungen werden lokal
  // festgeschrieben (ohne updatedAt zu ändern, damit der Drive-Vergleich stimmt).
  migrate() {
    let touched = false;
    if (!Array.isArray(this.db.relations)) { this.db.relations = []; touched = true; }
    if (!Array.isArray(this.db.tags)) { this.db.tags = DEFAULT_TAGS.map(t => ({ ...t })); touched = true; }
    if (!this.db.tags.some(t => t.id === UNSORTED_TAG_ID)) {
      this.db.tags.unshift({ id: UNSORTED_TAG_ID, name: "Unsortiert" });
      touched = true;
    }
    const validTagIds = new Set(this.db.tags.map(t => t.id));
    for (const p of this.db.persons) {
      if (p.company === undefined) { p.company = ""; touched = true; }
      if (p.position === undefined) { p.position = ""; touched = true; }
      if (p.death === undefined) { p.death = null; touched = true; }
      if (!Array.isArray(p.tagIds)) { p.tagIds = []; touched = true; }
      const cleaned = p.tagIds.filter(id => validTagIds.has(id));
      if (cleaned.length !== p.tagIds.length) { p.tagIds = cleaned; touched = true; }
      if (p.tagIds.length === 0) { p.tagIds = [UNSORTED_TAG_ID]; touched = true; }
    }
    if (touched) this.save(false);
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

  createPerson({ firstName, lastName = "", birthDate = null, birthYear = null, ageYears = null, estimated = false, company = "", position = "", deceased = false, deathDate = null, deathYear = null }) {
    const birth = normalizeBirth({ birthDate, birthYear, ageYears, estimated });
    const p = {
      id: this.newId(),
      firstName: (firstName || "").trim(),
      lastName: (lastName || "").trim(),
      birth,
      death: normalizeDeath({ deceased, deathDate, deathYear }),
      company: (company || "").trim(),
      position: (position || "").trim(),
      tagIds: [UNSORTED_TAG_ID],
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
    if (fields.deceased !== undefined || fields.deathDate !== undefined || fields.deathYear !== undefined) {
      if (fields.deceased === false) {
        p.death = null;
      } else {
        p.death = normalizeDeath({
          deceased: fields.deceased ?? true,
          deathDate: fields.deathDate ?? p.death?.date ?? null,
          deathYear: fields.deathYear ?? p.death?.year ?? null,
        });
      }
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

  // ---------- Kategorien (Tags) ----------

  allTags() {
    return [...this.db.tags].sort((a, b) =>
      a.id === UNSORTED_TAG_ID ? 1 : b.id === UNSORTED_TAG_ID ? -1 : a.name.localeCompare(b.name, "de"));
  },

  getTag(id) { return this.db.tags.find(t => t.id === id) || null; },

  findTagByName(name) {
    const q = normTag(name);
    if (!q) return null;
    return this.db.tags.find(t => normTag(t.name) === q) ||
           this.db.tags.find(t => normTag(t.name).startsWith(q)) || null;
  },

  createTag(name) {
    const clean = (name || "").trim();
    if (!clean) return null;
    const existing = this.findTagByName(clean);
    if (existing && normTag(existing.name) === normTag(clean)) return existing;
    const tag = { id: this.newId().replace("p_", "t_"), name: clean };
    this.db.tags.push(tag);
    this.save();
    return tag;
  },

  renameTag(id, newName) {
    const tag = this.getTag(id);
    const clean = (newName || "").trim();
    if (!tag || !clean || id === UNSORTED_TAG_ID) return false;
    tag.name = clean;
    this.save();
    return true;
  },

  deleteTag(id) {
    if (id === UNSORTED_TAG_ID || !this.getTag(id)) return false;
    this.db.tags = this.db.tags.filter(t => t.id !== id);
    for (const p of this.db.persons) {
      p.tagIds = p.tagIds.filter(tid => tid !== id);
      if (p.tagIds.length === 0) p.tagIds = [UNSORTED_TAG_ID];
    }
    this.save();
    return true;
  },

  addTagToPerson(personId, tagId) {
    const p = this.get(personId);
    if (!p || !this.getTag(tagId)) return;
    if (!p.tagIds.includes(tagId)) {
      p.tagIds.push(tagId);
      // Sobald eine echte Zuordnung existiert, fliegt "Unsortiert" raus
      if (tagId !== UNSORTED_TAG_ID)
        p.tagIds = p.tagIds.filter(id => id !== UNSORTED_TAG_ID);
      this.save();
    }
  },

  removeTagFromPerson(personId, tagId) {
    const p = this.get(personId);
    if (!p) return;
    p.tagIds = p.tagIds.filter(id => id !== tagId);
    if (p.tagIds.length === 0) p.tagIds = [UNSORTED_TAG_ID];
    this.save();
  },

  tagsOf(personId) {
    const p = this.get(personId);
    return p ? p.tagIds.map(id => this.getTag(id)).filter(Boolean) : [];
  },

  personsWithTag(tagId) {
    return this.all().filter(p => p.tagIds.includes(tagId));
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

// Tag-Namen tolerant vergleichen: "familie 1 grad" trifft "Familie 1. Grad"
function normTag(s) {
  return norm(s).replace(/[.\-,]/g, "").replace(/\s+/g, " ").trim();
}

// birth: { date: "YYYY-MM-DD"|null, year: number|null, estimated: bool, capturedAt?: "YYYY-MM-DD" }
// capturedAt = Tag, an dem ein reines Alter erfasst wurde → erlaubt genauere Schätzung.
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
    if (a >= 0 && a < 130) {
      const today = new Date().toISOString().slice(0, 10);
      return { date: null, year: new Date().getFullYear() - a, estimated: true, capturedAt: today };
    }
  }
  return null;
}

// death: null (lebt) | { date: "YYYY-MM-DD"|null, year: number|null }
function normalizeDeath({ deceased, deathDate, deathYear }) {
  if (!deceased && !deathDate && !deathYear) return null;
  const death = { date: null, year: null };
  if (deathDate) {
    const d = String(deathDate).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { death.date = d; death.year = Number(d.slice(0, 4)); }
  }
  if (!death.year && deathYear) {
    const y = Number(deathYear);
    if (y > 1880 && y <= new Date().getFullYear()) death.year = y;
  }
  return death;
}

// Volle Jahre zwischen einem Datum und einem Stichtag
function fullYears(from, until) {
  let years = until.getFullYear() - from.getFullYear();
  const hadBirthday = (until.getMonth() > from.getMonth()) ||
    (until.getMonth() === from.getMonth() && until.getDate() >= from.getDate());
  if (!hadBirthday) years--;
  return years;
}

// Bester bekannter „Geburtstag": exaktes Datum, oder Erfassungstag im geschätzten Geburtsjahr
function birthAnchor(person) {
  const b = person.birth;
  if (!b) return null;
  if (b.date) return { date: new Date(b.date + "T00:00:00"), estimated: false };
  if (b.year) {
    const cap = b.capturedAt || (b.estimated && person.createdAt ? person.createdAt.slice(0, 10) : null);
    if (b.estimated && cap) {
      const anchor = new Date(cap + "T00:00:00");
      anchor.setFullYear(b.year);
      return { date: anchor, estimated: true };
    }
    return { date: new Date(b.year, 0, 1), estimated: b.estimated, yearOnly: true };
  }
  return null;
}

export function ageOf(person) {
  const anchor = birthAnchor(person);
  if (!anchor) return null;
  const until = person.death?.date ? new Date(person.death.date + "T00:00:00")
    : person.death?.year ? new Date(person.death.year, 11, 31)
    : new Date();
  if (person.death && !person.death.date && !person.death.year) return null;
  if (anchor.yearOnly) {
    const untilYear = person.death?.year ?? new Date().getFullYear();
    return { years: untilYear - anchor.date.getFullYear(), estimated: anchor.estimated || !!person.death };
  }
  return { years: fullYears(anchor.date, until), estimated: anchor.estimated || (!!person.death && !person.death.date) };
}

export function ageText(person) {
  if (person.death) {
    const d = person.death;
    let when = d.date ? new Date(d.date + "T00:00:00").toLocaleDateString("de-DE") : (d.year || "");
    let s = when ? `† ${when}` : "verstorben";
    const a = ageOf(person);
    if (a) s += `, wurde ${a.estimated ? "ca. " : ""}${a.years} Jahre`;
    return s;
  }
  const a = ageOf(person);
  if (!a) return "Alter unbekannt";
  return a.estimated ? `ca. ${a.years} Jahre` : `${a.years} Jahre`;
}

// Für Sprachantworten: „Peter ist 2023 verstorben und wurde ca. 78 Jahre alt."
export function deceasedSentence(person) {
  const d = person.death;
  if (!d) return null;
  const when = d.date ? "am " + new Date(d.date + "T00:00:00").toLocaleDateString("de-DE") : (d.year ? String(d.year) : "");
  let s = `${fullName(person)} ist ${when ? when + " " : ""}verstorben`;
  const a = ageOf(person);
  if (a) s += ` und wurde ${a.estimated ? "ca. " : ""}${a.years} Jahre alt`;
  return s + ".";
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
