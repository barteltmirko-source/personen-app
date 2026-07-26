// tree.js — Stammbaum: Generationen berechnen, anordnen, als SVG zeichnen
"use strict";

import { Store, ageText, fullName } from "./store.js";

const NODE_W = 142, NODE_H = 54;
const H_GAP = 26, COUPLE_GAP = 16, V_GAP = 76;
const MARGIN = 26;

// „from ist LABEL von to" → Ebenenversatz von from gegenüber to (negativ = weiter oben).
// Nur diese Wörter bekommen eine Generation; alles andere landet im Anhang.
const GEN_OFFSET = {
  urgrossmutter: -3, urgrossvater: -3, uroma: -3, uropa: -3, urgrosseltern: -3,
  oma: -2, opa: -2, grossmutter: -2, grossvater: -2, grosseltern: -2,
  mutter: -1, vater: -1, onkel: -1, tante: -1, pate: -1, patin: -1,
  stiefvater: -1, stiefmutter: -1, schwiegervater: -1, schwiegermutter: -1,
  bruder: 0, schwester: 0, geschwister: 0, cousin: 0, cousine: 0,
  schwager: 0, schwaegerin: 0, ehemann: 0, ehefrau: 0, partner: 0, partnerin: 0,
  sohn: 1, tochter: 1, neffe: 1, nichte: 1,
  patenkind: 1, patensohn: 1, patentochter: 1,
  schwiegersohn: 1, schwiegertochter: 1,
  enkel: 2, enkelin: 2, enkelkind: 2,
};

function normLabel(s) {
  return (s || "").toLowerCase().trim()
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
    .replace(/[^a-z]/g, "");
}

// ---------- 1. Familie einsammeln und Generationen vergeben ----------

// BFS über Eltern/Kind/Partner ab einem Startpunkt mit bekannter Generation
function expandCluster(seedId, seedGen, gen, members) {
  if (members.has(seedId) || !Store.get(seedId)) return false;
  const queue = [[seedId, seedGen]];
  while (queue.length) {
    const [id, g] = queue.shift();
    if (members.has(id)) continue;
    const p = Store.get(id);
    if (!p) continue;
    members.add(id);
    gen.set(id, g);
    const partner = Store.partnerOf(id);
    if (partner) queue.push([partner.id, g]);
    for (const par of Store.parentsOf(id)) queue.push([par.id, g - 1]);
    for (const ch of Store.childrenOf(id)) queue.push([ch.id, g + 1]);
  }
  return true;
}

export function buildFamily(rootId) {
  const gen = new Map();
  const members = new Set();
  const bridgeLabel = new Map(); // personId → Etikett, über das sie dazukam
  expandCluster(rootId, 0, gen, members);

  // Freie Beziehungen als Brücke: holt die ganze Familie der anderen Person dazu
  let changed = true;
  while (changed) {
    changed = false;
    for (const rel of Store.db.relations) {
      const fromIn = members.has(rel.fromId), toIn = members.has(rel.toId);
      if (fromIn === toIn) continue;
      const offset = GEN_OFFSET[normLabel(rel.label)];
      if (offset === undefined) continue; // ohne Generation → Anhang
      const insideId = fromIn ? rel.fromId : rel.toId;
      const outsideId = fromIn ? rel.toId : rel.fromId;
      // GEN_OFFSET beschreibt from relativ zu to
      const outsideGen = fromIn
        ? gen.get(insideId) - offset
        : gen.get(insideId) + offset;
      if (expandCluster(outsideId, outsideGen, gen, members)) {
        bridgeLabel.set(outsideId, rel.label);
        changed = true;
      }
    }
  }

  // Beziehungen ohne Generationsbedeutung (Nachbar, Chef, …) → abgesetzter Block
  const extras = [];
  const seenExtra = new Set();
  for (const rel of Store.db.relations) {
    const fromIn = members.has(rel.fromId), toIn = members.has(rel.toId);
    if (fromIn === toIn) continue;
    const outsideId = fromIn ? rel.toId : rel.fromId;
    const insideId = fromIn ? rel.fromId : rel.toId;
    if (members.has(outsideId) || seenExtra.has(outsideId)) continue;
    const person = Store.get(outsideId), inside = Store.get(insideId);
    if (!person || !inside) continue;
    seenExtra.add(outsideId);
    extras.push({
      person,
      label: fromIn ? `${rel.label} von ${inside.firstName}` : `${inside.firstName} ist ${rel.label}`,
    });
  }

  return { members, gen, bridgeLabel, extras };
}

// ---------- 2. Anordnen ----------

function unitWidth(u) {
  return u.personIds.length === 2 ? NODE_W * 2 + COUPLE_GAP : NODE_W;
}

// Waagerechte Position einer Person innerhalb ihrer Einheit
function personX(unit, personId) {
  if (unit.personIds.length === 1) return unit.x;
  const half = (NODE_W + COUPLE_GAP) / 2;
  return unit.personIds[0] === personId ? unit.x - half : unit.x + half;
}

function resolveRow(row) {
  row.sort((a, b) => a.x - b.x);
  for (let i = 1; i < row.length; i++) {
    const minX = row[i - 1].x + unitWidth(row[i - 1]) / 2 + H_GAP + unitWidth(row[i]) / 2;
    if (row[i].x < minX) row[i].x = minX;
  }
}

const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

export function layoutFamily(family) {
  const { members, gen } = family;

  // Einheiten bilden: Paare stehen zusammen
  const unitOf = new Map();
  const units = [];
  for (const id of members) {
    if (unitOf.has(id)) continue;
    const p = Store.get(id);
    const partnerId = p.partnerId;
    const pairs = (partnerId && members.has(partnerId) && gen.get(partnerId) === gen.get(id))
      ? [id, partnerId].sort((a, b) => fullName(Store.get(a)).localeCompare(fullName(Store.get(b)), "de"))
      : [id];
    const unit = { personIds: pairs, gen: gen.get(id), x: 0, y: 0 };
    units.push(unit);
    pairs.forEach(pid => unitOf.set(pid, unit));
  }

  const byGen = new Map();
  for (const u of units) {
    if (!byGen.has(u.gen)) byGen.set(u.gen, []);
    byGen.get(u.gen).push(u);
  }
  const gens = [...byGen.keys()].sort((a, b) => a - b);

  // Verwandte Einheiten nachschlagen
  const childUnitsOf = u => {
    const out = new Set();
    for (const pid of u.personIds)
      for (const c of Store.childrenOf(pid))
        if (unitOf.has(c.id)) out.add(unitOf.get(c.id));
    return [...out];
  };
  const parentUnitsOf = u => {
    const out = new Set();
    for (const pid of u.personIds)
      for (const par of Store.parentsOf(pid))
        if (unitOf.has(par.id)) out.add(unitOf.get(par.id));
    return [...out];
  };

  // Startaufstellung, dann abwechselnd Eltern über Kinder und Kinder unter Eltern rücken
  for (const g of gens) {
    byGen.get(g).forEach((u, i) => { u.x = i * (NODE_W + H_GAP); });
    resolveRow(byGen.get(g));
  }
  for (let iter = 0; iter < 40; iter++) {
    for (let i = gens.length - 1; i >= 0; i--) {
      for (const u of byGen.get(gens[i])) {
        const kids = childUnitsOf(u);
        if (kids.length) u.x = u.x * 0.35 + avg(kids.map(k => k.x)) * 0.65;
      }
      resolveRow(byGen.get(gens[i]));
    }
    for (let i = 0; i < gens.length; i++) {
      for (const u of byGen.get(gens[i])) {
        const pars = parentUnitsOf(u);
        if (pars.length) u.x = u.x * 0.35 + avg(pars.map(p => p.x)) * 0.65;
      }
      resolveRow(byGen.get(gens[i]));
    }
  }

  // Senkrecht einsortieren und linksbündig normalisieren
  gens.forEach((g, i) => byGen.get(g).forEach(u => { u.y = MARGIN + i * (NODE_H + V_GAP); }));
  const minX = Math.min(...units.map(u => u.x - unitWidth(u) / 2));
  units.forEach(u => { u.x += MARGIN - minX; });

  return { units, unitOf, byGen, gens, childUnitsOf };
}

// ---------- 3. Zeichnen ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shorten(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function nodeSvg(person, x, y, opts = {}) {
  const cls = ["tree-node"];
  if (opts.root) cls.push("is-root");
  if (person.death) cls.push("is-dead");
  if (opts.dashed) cls.push("is-extra");
  const label = opts.label
    ? `<text class="tree-bridge" x="${x}" y="${y - 7}" text-anchor="middle">${esc(shorten(opts.label, 24))}</text>`
    : "";
  return `<g class="${cls.join(" ")}" data-id="${person.id}">
    ${label}
    <rect x="${x - NODE_W / 2}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="11"/>
    <text class="tree-name" x="${x}" y="${y + 22}" text-anchor="middle">${esc(shorten(fullName(person), 19))}</text>
    <text class="tree-sub" x="${x}" y="${y + 39}" text-anchor="middle">${esc(shorten(ageText(person), 24))}</text>
  </g>`;
}

export function renderFamilySvg(rootId) {
  const family = buildFamily(rootId);
  const { units, unitOf, childUnitsOf } = layoutFamily(family);
  const { bridgeLabel, extras } = family;

  const links = [];
  for (const u of units) {
    // Kinder dieser Einheit (personenbezogen, damit Stiefeltern nicht mitgezogen werden)
    const kids = [];
    for (const pid of u.personIds)
      for (const c of Store.childrenOf(pid))
        if (unitOf.has(c.id) && !kids.some(k => k.id === c.id)) kids.push(c);
    if (!kids.length) continue;
    const fromY = u.y + NODE_H;
    const busY = fromY + V_GAP / 2;
    const childXs = kids.map(c => personX(unitOf.get(c.id), c.id));
    const childY = unitOf.get(kids[0].id).y;
    links.push(`<path class="tree-link" d="M ${u.x} ${fromY} V ${busY}"/>`);
    links.push(`<path class="tree-link" d="M ${Math.min(...childXs, u.x)} ${busY} H ${Math.max(...childXs, u.x)}"/>`);
    for (const cx of childXs)
      links.push(`<path class="tree-link" d="M ${cx} ${busY} V ${childY}"/>`);
  }

  const nodes = [];
  const hearts = [];
  for (const u of units) {
    for (const pid of u.personIds) {
      const p = Store.get(pid);
      nodes.push(nodeSvg(p, personX(u, pid), u.y, {
        root: pid === rootId,
        label: bridgeLabel.get(pid),
      }));
    }
    if (u.personIds.length === 2)
      hearts.push(`<text class="tree-heart" x="${u.x}" y="${u.y + NODE_H / 2 + 5}" text-anchor="middle">♥</text>`);
  }

  let contentW = Math.max(...units.map(u => u.x + unitWidth(u) / 2)) + MARGIN;
  let contentH = Math.max(...units.map(u => u.y)) + NODE_H + MARGIN;

  // Anhang: Beziehungen ohne Generation
  const extraParts = [];
  if (extras.length) {
    const sepY = contentH + 10;
    extraParts.push(`<path class="tree-sep" d="M ${MARGIN} ${sepY} H ${Math.max(contentW - MARGIN, MARGIN + 120)}"/>`);
    const rowY = sepY + 34;
    extras.forEach((e, i) => {
      const x = MARGIN + NODE_W / 2 + i * (NODE_W + H_GAP);
      extraParts.push(nodeSvg(e.person, x, rowY, { dashed: true, label: e.label }));
      contentW = Math.max(contentW, x + NODE_W / 2 + MARGIN);
    });
    contentH = rowY + NODE_H + MARGIN;
  }

  const svg = `<svg id="tree-svg" viewBox="0 0 ${contentW} ${contentH}" xmlns="http://www.w3.org/2000/svg">
    <g class="tree-links">${links.join("")}</g>
    ${hearts.join("")}
    ${nodes.join("")}
    ${extraParts.join("")}
  </svg>`;

  return { svg, contentW, contentH, count: family.members.size, extraCount: extras.length };
}
