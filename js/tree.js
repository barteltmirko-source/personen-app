// tree.js — Stammbaum: Ausschnitt bestimmen, anordnen, als SVG zeichnen
//
// Ausschnitt: die Eltern der gewählten Person bilden die oberste Reihe, darunter
// alle ihre Nachkommen (Geschwister, Neffen, Enkel …). Angeheiratete Personen
// werden ergänzt, damit Elternblöcke vollständig sind, aber nicht weiterverfolgt.
//
// Gezeichnet werden ausschließlich Eltern→Kind-Verbindungen, und zwar als einzelne
// Kurve von jedem Elternteil zu jedem Kind. Nebeneinanderstehen ist reine Anordnung:
// Eltern gemeinsamer Kinder bilden einen Block. Wer mit mehreren Partnern Kinder hat,
// erscheint mehrfach — Zweitkästchen sind als Dublette (↗) gekennzeichnet.
"use strict";

import { Store, ageOf, fullName } from "./store.js";

// Zwei Textzeilen unter dem Namen (Lebensdaten + Alter) brauchen etwas mehr
// Kasten als die eine Zeile davor.
const NODE_W = 158, NODE_H = 60;
const H_GAP = 30, PAIR_GAP = 14, V_GAP = 82;
const MARGIN = 26;

// ---------- 1. Ausschnitt einsammeln und Generationen vergeben ----------

export function buildFamily(rootId) {
  const gen = new Map();
  const members = new Set();
  if (!Store.get(rootId)) return { members, gen, extras: [] };

  // Oberste Reihe: die Eltern der gewählten Person — oder sie selbst, wenn keine bekannt
  const parents = Store.parentsOf(rootId).map(p => p.id);
  const tops = parents.length ? parents : [rootId];

  // Von dort aus alle Generationen nach unten
  const queue = tops.map(id => [id, 0]);
  while (queue.length) {
    const [id, g] = queue.shift();
    if (members.has(id) || !Store.get(id)) continue;
    members.add(id);
    gen.set(id, g);
    for (const c of Store.childrenOf(id)) queue.push([c.id, g + 1]);
  }

  // Angeheiratete ergänzen (Mit-Eltern und Partner), aber nicht weiterverfolgen
  const pending = [];
  for (const id of members) {
    const p = Store.get(id);
    for (const c of Store.childrenOf(id))
      for (const co of Store.parentsOf(c.id))
        if (!members.has(co.id)) pending.push([co.id, gen.get(c.id) - 1]);
    if (p.partnerId && !members.has(p.partnerId)) pending.push([p.partnerId, gen.get(id)]);
  }
  for (const [id, g] of pending) {
    if (members.has(id) || !Store.get(id)) continue;
    members.add(id);
    gen.set(id, g);
  }

  // Freie Beziehungen (Tante, Opa, Nachbar …) → abgesetzter Block „Weitere Verbundene"
  const extras = [];
  const seenExtra = new Set();
  for (const rel of Store.db.relations) {
    const fromIn = members.has(rel.fromId), toIn = members.has(rel.toId);
    if (fromIn === toIn) continue;
    const outsideId = fromIn ? rel.toId : rel.fromId;
    const inside = Store.get(fromIn ? rel.fromId : rel.toId);
    const person = Store.get(outsideId);
    if (!person || !inside || seenExtra.has(outsideId)) continue;
    seenExtra.add(outsideId);
    // Die Beziehung lautet „from ist LABEL von to"
    extras.push({
      person,
      label: fromIn ? `${inside.firstName} ist ${rel.label}` : `${rel.label} von ${inside.firstName}`,
    });
  }

  return { members, gen, extras };
}

// ---------- 2. Blöcke bilden ----------

// Eltern eines Kindes, auf die Familie beschränkt und stabil sortiert
function parentKeyOf(person, members) {
  return person.parentIds.filter(id => members.has(id)).sort().join("|");
}

export function buildBlocks(family, rootId) {
  const { members, gen } = family;
  const blocks = [];
  const seenKeys = new Set();
  const placed = new Set();

  const childrenByKey = new Map();
  for (const id of members) {
    const key = parentKeyOf(Store.get(id), members);
    if (!key) continue;
    if (!childrenByKey.has(key)) childrenByKey.set(key, []);
    childrenByKey.get(key).push(Store.get(id));
  }

  const addBlock = (ids, kind) => {
    const sorted = [...ids].sort();
    const key = sorted.join("|");
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    blocks.push({ ids: sorted, key, kind, gen: Math.min(...sorted.map(i => gen.get(i))), x: 0, y: 0 });
    sorted.forEach(i => placed.add(i));
  };

  // (a) Elternblöcke — jede vorkommende Elternkombination, die Kinder hat
  for (const key of childrenByKey.keys()) addBlock(key.split("|"), "parents");

  // (b) Partnerschaften ohne gemeinsame Kinder — stehen nur nebeneinander, keine Linie
  for (const id of members) {
    const p = Store.get(id);
    if (p.partnerId && members.has(p.partnerId)) addBlock([id, p.partnerId], "couple");
  }

  // (c) alle Übrigen einzeln
  for (const id of members) if (!placed.has(id)) addBlock([id], "single");

  // Welche Blöcke enthalten eine Person?
  const blocksOf = new Map();
  for (const b of blocks)
    for (const id of b.ids) {
      if (!blocksOf.has(id)) blocksOf.set(id, []);
      blocksOf.get(id).push(b);
    }

  // Abstammungslinie der geöffneten Person: Vorfahren + Nachkommen
  const rootLine = new Set([rootId]);
  const walk = (id, next) => {
    for (const p of next(id)) if (!rootLine.has(p.id)) { rootLine.add(p.id); walk(p.id, next); }
  };
  walk(rootId, id => Store.parentsOf(id));
  walk(rootId, id => Store.childrenOf(id));

  // Hauptkästchen bestimmen: bevorzugt der Zweig, dem die geöffnete Person entstammt
  const primaryOf = new Map();
  for (const [id, list] of blocksOf) {
    if (list.length === 1) { primaryOf.set(id, list[0]); continue; }
    let best = null, bestScore = -Infinity;
    for (const b of list) {
      const kids = childrenByKey.get(b.key) || [];
      let score = kids.length;
      if (kids.some(c => rootLine.has(c.id))) score += 100;
      if (b.ids.some(i => i !== id && rootLine.has(i))) score += 50;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    primaryOf.set(id, best);
  }

  return { blocks, blocksOf, primaryOf, childrenByKey };
}

// ---------- 3. Anordnen ----------

const blockWidth = b => b.ids.length * NODE_W + (b.ids.length - 1) * PAIR_GAP;

// Waagerechte Mitte eines Kästchens innerhalb seines Blocks
function boxX(block, index) {
  return block.x - blockWidth(block) / 2 + NODE_W / 2 + index * (NODE_W + PAIR_GAP);
}

function resolveRow(row) {
  row.sort((a, b) => a.x - b.x);
  for (let i = 1; i < row.length; i++) {
    const minX = row[i - 1].x + blockWidth(row[i - 1]) / 2 + H_GAP + blockWidth(row[i]) / 2;
    if (row[i].x < minX) row[i].x = minX;
  }
}

const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

export function layoutBlocks(family, model) {
  const { members } = family;
  const { blocks, primaryOf, childrenByKey } = model;
  const blockByKey = new Map(blocks.map(b => [b.key, b]));

  // Kindblöcke: wo landen die Kinder dieses Elternblocks?
  const childBlocksOf = b => {
    const out = new Set();
    for (const c of childrenByKey.get(b.key) || []) {
      const pb = primaryOf.get(c.id);
      if (pb) out.add(pb);
    }
    return [...out];
  };
  // Elternblöcke: nur für Personen, deren Hauptkästchen in diesem Block liegt
  const parentBlocksOf = b => {
    const out = new Set();
    for (const id of b.ids) {
      if (primaryOf.get(id) !== b) continue;
      const key = parentKeyOf(Store.get(id), members);
      const pb = key && blockByKey.get(key);
      if (pb) out.add(pb);
    }
    return [...out];
  };

  const byGen = new Map();
  for (const b of blocks) {
    if (!byGen.has(b.gen)) byGen.set(b.gen, []);
    byGen.get(b.gen).push(b);
  }
  const gens = [...byGen.keys()].sort((a, b) => a - b);

  for (const g of gens) {
    byGen.get(g).forEach((b, i) => { b.x = i * (NODE_W + H_GAP); });
    resolveRow(byGen.get(g));
  }
  for (let iter = 0; iter < 45; iter++) {
    for (let i = gens.length - 1; i >= 0; i--) {
      for (const b of byGen.get(gens[i])) {
        const kids = childBlocksOf(b);
        if (kids.length) b.x = b.x * 0.35 + avg(kids.map(k => k.x)) * 0.65;
      }
      resolveRow(byGen.get(gens[i]));
    }
    for (let i = 0; i < gens.length; i++) {
      for (const b of byGen.get(gens[i])) {
        const pars = parentBlocksOf(b);
        if (pars.length) b.x = b.x * 0.35 + avg(pars.map(p => p.x)) * 0.65;
      }
      resolveRow(byGen.get(gens[i]));
    }
  }

  gens.forEach((g, i) => byGen.get(g).forEach(b => { b.y = MARGIN + i * (NODE_H + V_GAP); }));
  const minX = Math.min(...blocks.map(b => b.x - blockWidth(b) / 2));
  blocks.forEach(b => { b.x += MARGIN - minX; });

  // Innerhalb eines Paarblocks die Seite wählen, die näher an der eigenen Herkunft liegt
  for (const b of blocks) {
    if (b.ids.length !== 2) continue;
    const originX = id => {
      const key = parentKeyOf(Store.get(id), members);
      const pb = key && blockByKey.get(key);
      return pb ? pb.x : null;
    };
    const [a, c] = [originX(b.ids[0]), originX(b.ids[1])];
    const flip =
      (a !== null && c !== null) ? a > c :
      (a !== null) ? a > b.x :
      (c !== null) ? c < b.x : false;
    if (flip) b.ids.reverse();
  }

  return { blocks, gens, byGen };
}

// ---------- 4. Zeichnen ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const shorten = (s, max) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

const deDate = iso => new Date(iso + "T00:00:00").toLocaleDateString("de-DE");

// Zwei Zeilen unter dem Namen: erst die Lebensdaten, dann das Alter.
// Ist nur ein Jahr bekannt, steht das Jahr da; ist gar nichts bekannt,
// entfällt die Datumszeile und der Kasten zeigt nur eine Unterzeile.
function lifeLines(person) {
  const b = person.birth, d = person.death;
  // Ein aus dem Alter zurückgerechnetes Jahr ist geraten — das muss man sehen.
  const birth = b?.date ? deDate(b.date)
    : b?.year ? (b.estimated ? "ca. " : "") + b.year
    : (b?.day && b?.month) ? `${b.day}.${b.month}.` // Tag und Monat ohne Jahr
    : null;
  const a = ageOf(person);
  const years = a ? `${a.estimated ? "ca. " : ""}${a.years} Jahre` : null;

  if (d) {
    const death = d.date ? deDate(d.date) : (d.year ? String(d.year) : null);
    return [
      birth && death ? `* ${birth} † ${death}` : death ? `† ${death}` : birth ? `* ${birth}` : null,
      years ? `wurde ${years}` : "verstorben",
    ];
  }
  return [birth ? `* ${birth}` : null, years || "Alter unbekannt"];
}

function nodeSvg(person, x, y, opts = {}) {
  const cls = ["tree-node"];
  if (opts.root) cls.push("is-root");
  if (person.death) cls.push("is-dead");
  if (opts.duplicate) cls.push("is-dup");
  if (opts.extra) cls.push("is-extra");
  const label = opts.label
    ? `<text class="tree-bridge" x="${x}" y="${y - 7}" text-anchor="middle">${esc(shorten(opts.label, 24))}</text>`
    : "";
  const dup = opts.duplicate
    ? `<text class="tree-dup" x="${x + NODE_W / 2 - 9}" y="${y + 15}" text-anchor="middle">↗</text>`
    : "";
  const subs = lifeLines(person).filter(Boolean);
  const subText = subs.map((line, i) =>
    `<text class="tree-sub" x="${x}" y="${y + (subs.length === 1 ? 40 : 35 + i * 14)}" text-anchor="middle">${esc(shorten(line, 25))}</text>`
  ).join("");
  return `<g class="${cls.join(" ")}" data-id="${person.id}">
    ${label}
    <rect x="${x - NODE_W / 2}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="11"/>
    <text class="tree-name" x="${x}" y="${y + 19}" text-anchor="middle">${esc(shorten(fullName(person), 21))}</text>
    ${subText}
    ${dup}
  </g>`;
}

// Geschwungene Linie von einem Elternteil zu einem Kind
function curve(px, py, cx, cy) {
  const dy = cy - py;
  return `<path class="tree-link" d="M ${px.toFixed(1)} ${py.toFixed(1)} C ${px.toFixed(1)} ${(py + dy * 0.45).toFixed(1)}, ${cx.toFixed(1)} ${(cy - dy * 0.45).toFixed(1)}, ${cx.toFixed(1)} ${cy.toFixed(1)}"/>`;
}

export function renderFamilySvg(rootId) {
  const family = buildFamily(rootId);
  const model = buildBlocks(family, rootId);
  layoutBlocks(family, model);
  const { blocks, primaryOf, childrenByKey } = model;
  const { extras, members } = family;

  // Eine Linie je Elternteil und Kind
  const links = [];
  for (const b of blocks) {
    const kids = childrenByKey.get(b.key) || [];
    if (!kids.length) continue;
    b.ids.forEach((pid, i) => {
      const px = boxX(b, i), py = b.y + NODE_H;
      for (const c of kids) {
        const cb = primaryOf.get(c.id);
        if (!cb) continue;
        links.push(curve(px, py, boxX(cb, cb.ids.indexOf(c.id)), cb.y));
      }
    });
  }

  const nodes = [];
  for (const b of blocks)
    b.ids.forEach((pid, i) => {
      nodes.push(nodeSvg(Store.get(pid), boxX(b, i), b.y, {
        root: pid === rootId && primaryOf.get(pid) === b,
        duplicate: primaryOf.get(pid) !== b,
      }));
    });

  let contentW = Math.max(...blocks.map(b => b.x + blockWidth(b) / 2)) + MARGIN;
  let contentH = Math.max(...blocks.map(b => b.y)) + NODE_H + MARGIN;

  // Anhang: Beziehungen ohne Generation
  const extraParts = [];
  if (extras.length) {
    const sepY = contentH + 10;
    extraParts.push(`<path class="tree-sep" d="M ${MARGIN} ${sepY} H ${Math.max(contentW - MARGIN, MARGIN + 120)}"/>`);
    const rowY = sepY + 34;
    extras.forEach((e, i) => {
      const x = MARGIN + NODE_W / 2 + i * (NODE_W + H_GAP);
      extraParts.push(nodeSvg(e.person, x, rowY, { extra: true, label: e.label }));
      contentW = Math.max(contentW, x + NODE_W / 2 + MARGIN);
    });
    contentH = rowY + NODE_H + MARGIN;
  }

  const dupCount = blocks.reduce((n, b) =>
    n + b.ids.filter(id => primaryOf.get(id) !== b).length, 0);

  const svg = `<svg id="tree-svg" viewBox="0 0 ${contentW} ${contentH}" xmlns="http://www.w3.org/2000/svg">
    <g class="tree-links">${links.join("")}</g>
    ${nodes.join("")}
    ${extraParts.join("")}
  </svg>`;

  return { svg, contentW, contentH, count: members.size, extraCount: extras.length, dupCount };
}
