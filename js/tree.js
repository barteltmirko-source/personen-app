// tree.js — Stammbaum: Generationen berechnen, anordnen, als SVG zeichnen
//
// Gezeichnet werden ausschließlich Eltern→Kind-Verbindungen, und zwar als einzelne
// Kurve von jedem Elternteil zu jedem Kind. Nebeneinanderstehen ist reine Anordnung:
// Eltern gemeinsamer Kinder bilden einen Block. Wer mit mehreren Partnern Kinder hat,
// erscheint mehrfach — Zweitkästchen sind als Dublette (↗) gekennzeichnet.
"use strict";

import { Store, ageText, fullName } from "./store.js";

const NODE_W = 142, NODE_H = 54;
const H_GAP = 30, PAIR_GAP = 14, V_GAP = 82;
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
  return `<g class="${cls.join(" ")}" data-id="${person.id}">
    ${label}
    <rect x="${x - NODE_W / 2}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="11"/>
    <text class="tree-name" x="${x}" y="${y + 22}" text-anchor="middle">${esc(shorten(fullName(person), 19))}</text>
    <text class="tree-sub" x="${x}" y="${y + 39}" text-anchor="middle">${esc(shorten(ageText(person), 24))}</text>
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
  const { bridgeLabel, extras, members } = family;

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
        label: primaryOf.get(pid) === b ? bridgeLabel.get(pid) : null,
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
