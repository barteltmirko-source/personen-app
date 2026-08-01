// app.js — Oberfläche und Navigation
"use strict";

import {
  Store, Settings, ageText, fullName, UNSORTED_TAG_ID,
  hasBirthday, nextBirthday, daysUntilBirthday, ageOnNextBirthday, parseDayMonth,
} from "./store.js";
import { parseIcs, nameFromSummary } from "./ics.js";
import { renderFamilySvg } from "./tree.js";
import { handleInput } from "./nlu.js";
import { Drive } from "./drive.js";
import { Calendar } from "./calendar.js";
import { speak, stopSpeaking } from "./speech.js";

Store.load();
Settings.load();
Calendar.dropLegacyEvents(); // muss nach dem Laden laufen, siehe calendar.js

const view = document.getElementById("view");
const syncStatus = document.getElementById("sync-status");
const modalRoot = document.getElementById("modal-root");

let currentTab = "assistant";
let chatLog = []; // { role: "user"|"app", text }

// ---------- Navigation ----------

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  render();
}

function render() {
  stopSpeaking();
  if (currentTab === "assistant") renderAssistant();
  else if (currentTab === "persons") renderPersons();
  else if (currentTab === "birthdays") renderBirthdays();
  else if (currentTab === "settings") renderSettings();
}

Store.onChange(() => {
  if (currentTab === "persons") renderPersons();
  else if (currentTab === "birthdays") renderBirthdays();
});

// ---------- Drive-Status ----------

Drive.onStatus((status, detail) => {
  const map = { getrennt: "#999", verbinde: "#e6a817", verbunden: "#2eae5d", fehler: "#d64545" };
  syncStatus.style.color = map[status] || "#999";
  syncStatus.title = "Google Drive: " + status + (detail ? " — " + detail : "");
  const el = document.getElementById("drive-status-text");
  if (el) el.textContent = statusText(status, detail);
});

// Fehler beim automatischen Kalender-Abgleich sollen nicht still verschwinden
Calendar.onStatus((status, detail) => {
  const el = document.getElementById("cal-status");
  if (el) el.textContent = status === "fehler" ? "Fehler: " + detail : detail || "Abgeglichen";
});

function statusText(status, detail) {
  const names = {
    getrennt: "Nicht verbunden",
    verbinde: "Verbinde …",
    verbunden: "Verbunden ✓",
    fehler: "Fehler",
  };
  return names[status] + (detail ? " — " + detail : "");
}

// ---------- Ansicht: Assistent ----------

function renderAssistant() {
  view.innerHTML = `
    <div class="assistant">
      <div id="chat" class="chat"></div>
      <div class="input-row">
        <textarea id="cmd-input" rows="2" enterkeyhint="send"
          placeholder="Tippe hier — oder drücke die 🎤-Taste auf der Tastatur und sprich."></textarea>
        <button id="cmd-send" class="btn primary" title="Senden">➤</button>
      </div>
      <p class="hint">Beispiele: „Welche Kinder hat Max Mustermann?" · „Neue Person: Anna Schmidt, 42, verheiratet mit Peter Schmidt" · „Notiz zu Anna: mag Gartenarbeit"</p>
    </div>`;

  const chat = document.getElementById("chat");
  const input = document.getElementById("cmd-input");
  const send = document.getElementById("cmd-send");

  drawChat();

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    chatLog.push({ role: "user", text });
    chatLog.push({ role: "app", text: "…", pending: true });
    drawChat();
    const result = await handleInput(text);
    chatLog.pop();
    chatLog.push({ role: "app", text: result.reply });
    drawChat();
    speak(result.reply);
  }

  send.addEventListener("click", submit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  function drawChat() {
    if (chatLog.length === 0) {
      chat.innerHTML = `<div class="empty">Frag mich etwas über deine Personen –<br>oder trage jemanden per Sprache ein.</div>`;
      return;
    }
    chat.innerHTML = chatLog.map(m =>
      `<div class="bubble ${m.role}${m.pending ? " pending" : ""}">${esc(m.text)}</div>`).join("");
    chat.scrollTop = chat.scrollHeight;
  }
}

// ---------- Ansicht: Personen ----------

const activeTagFilters = new Set(); // gewählte Kategorien; leer = alle anzeigen

function tagFilterLabel(selected) {
  if (selected.size === 0) return "Alle Kategorien";
  if (selected.size === 1) {
    const tag = Store.getTag([...selected][0]);
    if (tag) return tag.name;
  }
  return `${selected.size} Kategorien`;
}

// Kategorie-Filter als kompaktes Dropdown. Personen- und Geburtstagsliste
// nutzen dieselbe Leiste mit je eigener Auswahl; es ist immer nur eine
// Ansicht im DOM, deshalb dürfen sich die IDs wiederholen.
function tagFilterMarkup(selected) {
  const tags = Store.allTags();
  const validIds = new Set(tags.map(t => t.id));
  for (const id of selected) if (!validIds.has(id)) selected.delete(id);
  return `
    <div class="filter-bar">
      <button id="tag-menu-btn" class="filter-btn${selected.size ? " filtered" : ""}"
        aria-haspopup="true" aria-expanded="false">
        <span id="tag-menu-label">${esc(tagFilterLabel(selected))}</span>
        <span class="filter-caret">▾</span>
      </button>
      <div id="tag-menu" class="tag-menu" hidden>
        ${tags.map(t => `
          <label class="tag-menu-item">
            <input type="checkbox" data-tag="${t.id}" ${selected.has(t.id) ? "checked" : ""}>
            <span class="tag-menu-name">${esc(t.name)}</span>
            <span class="tag-menu-count">${Store.personsWithTag(t.id).length}</span>
          </label>`).join("")}
        <button id="tag-menu-clear" class="tag-menu-clear">Alle anzeigen</button>
      </div>
    </div>`;
}

function wireTagFilter(selected, onChange) {
  const menu = document.getElementById("tag-menu");
  const menuBtn = document.getElementById("tag-menu-btn");

  function refresh() {
    document.getElementById("tag-menu-label").textContent = tagFilterLabel(selected);
    menuBtn.classList.toggle("filtered", selected.size > 0);
    onChange();
  }

  menuBtn.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.classList.toggle("open", open);
  });

  menu.querySelectorAll('input[type="checkbox"]').forEach(cb =>
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(cb.dataset.tag);
      else selected.delete(cb.dataset.tag);
      refresh();
    }));

  document.getElementById("tag-menu-clear").addEventListener("click", () => {
    selected.clear();
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => (cb.checked = false));
    refresh();
    closeTagMenu();
  });
}

const matchesTags = (person, selected) =>
  selected.size === 0 || person.tagIds.some(id => selected.has(id));

function renderPersons(detailId = null) {
  if (detailId) return renderPersonDetail(detailId);

  view.innerHTML = `
    <div class="persons">
      <div class="toolbar">
        <input id="search" type="search" placeholder="Suchen …">
        <button id="add-person" class="btn primary">+ Neu</button>
      </div>
      ${tagFilterMarkup(activeTagFilters)}
      <div id="person-list" class="person-list"></div>
    </div>`;

  const list = document.getElementById("person-list");
  const search = document.getElementById("search");

  function draw(filter = "") {
    let items = filter ? Store.findByName(filter) : Store.all();
    items = items.filter(p => matchesTags(p, activeTagFilters));
    if (items.length === 0) {
      list.innerHTML = `<div class="empty">${(filter || activeTagFilters.size) ? `Keine Treffer.` : `Noch keine Personen.<br>Lege die erste über „+ Neu“ oder den Assistenten an.`}</div>`;
      return;
    }
    list.innerHTML = items.map(p => {
      const partner = Store.partnerOf(p.id);
      const kids = Store.childrenOf(p.id);
      const sub = [
        ageText(p),
        p.company || null,
        partner ? "♥ " + fullName(partner) : null,
        kids.length ? kids.length + (kids.length === 1 ? " Kind" : " Kinder") : null,
        p.notes.length ? "📝 " + p.notes.length : null,
      ].filter(Boolean).join(" · ");
      // Kategorien stehen bewusst nicht auf der Karte — das spart je Person eine Zeile
      return `<div class="card person-card" data-id="${p.id}">
        <div class="person-name">${esc(fullName(p))}</div>
        <div class="person-sub">${esc(sub)}</div>
      </div>`;
    }).join("");
    list.querySelectorAll(".person-card").forEach(card =>
      card.addEventListener("click", () => renderPersonDetail(card.dataset.id)));
  }

  draw();
  search.addEventListener("input", () => draw(search.value.trim()));
  document.getElementById("add-person").addEventListener("click", () => openPersonForm(null));

  wireTagFilter(activeTagFilters, () => draw(search.value.trim()));
}

// Einmalig registriert: das Filtermenü schließt bei Klick daneben oder mit Escape.
// (renderPersons ersetzt das DOM, deshalb hier keine Listener pro Aufruf anhängen.)
function closeTagMenu() {
  const menu = document.getElementById("tag-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const btn = document.getElementById("tag-menu-btn");
  if (btn) { btn.setAttribute("aria-expanded", "false"); btn.classList.remove("open"); }
}

document.addEventListener("click", e => {
  if (!e.target.closest("#tag-menu") && !e.target.closest("#tag-menu-btn")) closeTagMenu();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeTagMenu(); });

// ---------- Ansicht: Geburtstage ----------

const bdayTagFilters = new Set();
let bdayReminderFilter = "on"; // on = nur mit Erinnerung (Vorgabe) | all | off

function whenText(days, date) {
  if (days === 0) return "Heute!";
  const tag = date.toLocaleDateString("de-DE", { day: "numeric", month: "long" });
  if (days === 1) return `Morgen · ${tag}`;
  return `in ${days} Tagen · ${tag}`;
}

function renderBirthdays() {
  const modes = [["on", "Mit Erinnerung"], ["all", "Alle"], ["off", "Ohne Erinnerung"]];
  const incomplete = Calendar.incomplete();

  view.innerHTML = `
    <div class="birthdays">
      ${tagFilterMarkup(bdayTagFilters)}
      <div class="chip-row">
        ${modes.map(([m, t]) =>
          `<button class="chip ${bdayReminderFilter === m ? "active" : ""}" data-mode="${m}">${t}</button>`).join("")}
      </div>
      ${incomplete.length ? `<p class="muted small-text">⚠ ${incomplete.length === 1
        ? "Bei einer Person ist eine Erinnerung aktiv, aber kein volles Geburtsdatum hinterlegt"
        : `Bei ${incomplete.length} Personen ist eine Erinnerung aktiv, aber kein volles Geburtsdatum hinterlegt`} — ein Geburtsjahr allein ergibt keinen Geburtstag.</p>` : ""}
      <div id="bday-list"></div>
    </div>`;

  const list = document.getElementById("bday-list");

  function emptyText() {
    if (!Store.db.persons.some(hasBirthday))
      return "Noch keine Geburtstage.<br>Ein Geburtstag braucht Tag und Monat — ein Geburtsjahr allein genügt nicht.";
    if (bdayReminderFilter === "on")
      return "Für niemanden ist eine Erinnerung aktiv.<br>Wechsle auf „Alle“ und tippe auf die Glocke.";
    return "Keine Treffer für diesen Filter.";
  }

  function draw() {
    const items = Store.upcomingBirthdays().filter(({ person }) =>
      matchesTags(person, bdayTagFilters) && (
        bdayReminderFilter === "all" ? true :
        bdayReminderFilter === "on" ? person.birthdayReminder : !person.birthdayReminder));

    if (!items.length) {
      list.innerHTML = `<div class="empty">${emptyText()}</div>`;
      return;
    }

    list.innerHTML = items.map(({ person, days, date }) => {
      const turns = ageOnNextBirthday(person);
      const on = person.birthdayReminder;
      return `<div class="card bday-card${days === 0 ? " today" : ""}" data-id="${person.id}">
        <div class="bday-main">
          <div class="person-name">${esc(fullName(person))}</div>
          <div class="person-sub">${esc(whenText(days, date))}${turns ? ` · wird ${turns}` : ""}</div>
        </div>
        <button class="bday-bell${on ? " on" : ""}" data-bell="${person.id}" aria-pressed="${on}"
          title="${on ? "Erinnerung ausschalten" : "Erinnerung einschalten"}">${on ? "🔔" : "🔕"}</button>
      </div>`;
    }).join("");

    list.querySelectorAll(".bday-card").forEach(card =>
      card.addEventListener("click", () => renderPersonDetail(card.dataset.id)));

    // Store.onChange zeichnet die Ansicht neu — hier kein eigenes draw() nötig
    list.querySelectorAll("[data-bell]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const person = Store.get(btn.dataset.bell);
        if (person) Store.setBirthdayReminder(person.id, !person.birthdayReminder);
      }));
  }

  view.querySelectorAll("[data-mode]").forEach(chip =>
    chip.addEventListener("click", () => {
      bdayReminderFilter = chip.dataset.mode;
      view.querySelectorAll("[data-mode]").forEach(c =>
        c.classList.toggle("active", c.dataset.mode === bdayReminderFilter));
      draw();
    }));

  wireTagFilter(bdayTagFilters, draw);
  draw();
}

function renderPersonDetail(id) {
  const p = Store.get(id);
  if (!p) return renderPersons();
  const partner = Store.partnerOf(id);
  const kids = Store.childrenOf(id);
  const parents = Store.parentsOf(id);
  const grandparents = Store.grandparentsOf(id);
  const grandchildren = Store.grandchildrenOf(id);
  const { outgoing, incoming } = Store.relationsFor(id);
  const work = [p.position, p.company].filter(Boolean).join(" bei ");

  view.innerHTML = `
    <div class="detail">
      <button id="back" class="btn ghost">‹ Zurück</button>
      <div class="card">
        <div class="detail-head">
          <h2>${esc(fullName(p))}</h2>
          <button id="edit" class="btn small">Bearbeiten</button>
        </div>
        <div class="detail-age">${esc(ageText(p))}${
          p.birth?.date ? " · geb. " + new Date(p.birth.date + "T00:00:00").toLocaleDateString("de-DE")
          : p.birth?.year ? " · Jahrgang " + p.birth.year
          : (p.birth?.day && p.birth?.month) ? ` · Geburtstag am ${p.birth.day}.${p.birth.month}.`
          : ""}</div>
        ${work ? `<div class="detail-age">💼 ${esc(work)}</div>` : ""}
        ${(hasBirthday(p) || p.birthdayReminder) ? `
          <label class="toggle-row bday-toggle">
            <input type="checkbox" id="d-bday" ${p.birthdayReminder ? "checked" : ""}>
            🎂 An den Geburtstag erinnern
          </label>
          ${p.birthdayReminder && !hasBirthday(p)
            ? `<div class="muted small-text">Dafür fehlen noch Tag und Monat der Geburt.</div>` : ""}` : ""}

        <h3>Kategorien</h3>
        <div class="chip-row" id="detail-tags">
          ${Store.allTags().map(t => `<button class="chip ${p.tagIds.includes(t.id) ? "active" : ""}" data-tag="${t.id}">${esc(t.name)}</button>`).join("")}
        </div>

        <h3>Familie & Beziehungen</h3>
        <div class="family">
          ${partner ? linkRow("♥ Partner/in", partner, "partner") : `<div class="family-row muted">Kein Partner eingetragen</div>`}
          ${parents.map(par => linkRow("↑ Elternteil", par, "parent")).join("")}
          ${kids.map(k => linkRow("↓ Kind", k, "child")).join("")}
          ${grandparents.map(gp => linkRow("↑↑ Großeltern", gp)).join("")}
          ${grandchildren.map(gc => linkRow("↓↓ Enkel", gc)).join("")}
          ${outgoing.map(x => relRow(x.rel, `${esc(p.firstName)} ist ${esc(x.rel.label)} von`, x.other)).join("")}
          ${incoming.map(x => relRow(x.rel, `${esc(x.rel.label)}`, x.other)).join("")}
        </div>
        <button id="show-tree" class="btn tree-open">🌳 Stammbaum ansehen</button>
        <div class="family-actions">
          <button id="link-partner" class="btn small ghost">Partner verknüpfen</button>
          <button id="link-child" class="btn small ghost">Kind verknüpfen</button>
          <button id="link-rel" class="btn small ghost">Beziehung hinzufügen</button>
        </div>

        <h3>Notizen</h3>
        <div class="notes">
          ${p.notes.length === 0 ? `<div class="muted">Noch keine Notizen.</div>` : p.notes.map(n => `
            <div class="note" data-note="${n.id}">
              <div class="note-date">${new Date(n.date).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" })}</div>
              <div class="note-text">${esc(n.text)}</div>
              <button class="note-del" title="Notiz löschen">✕</button>
            </div>`).join("")}
        </div>
        <div class="input-row">
          <textarea id="new-note" rows="1" placeholder="Neue Notiz …"></textarea>
          <button id="add-note" class="btn primary">+</button>
        </div>

        <div class="danger-zone">
          <button id="delete-person" class="btn danger ghost small">Person löschen</button>
        </div>
      </div>
    </div>`;

  // unlink: "partner" | "parent" | "child" — abgeleitete Zeilen (Großeltern, Enkel)
  // bekommen kein ✕, die löst man über die Eltern-Kind-Verknüpfung dazwischen.
  function linkRow(label, person, unlink = null) {
    return `<div class="family-row link" data-id="${person.id}">
      <span class="family-label">${label}</span>
      <span>${esc(fullName(person))} <span class="muted">(${esc(ageText(person))})</span></span>
      ${unlink ? `<button class="rel-del" data-unlink="${unlink}" data-other="${person.id}" title="Verknüpfung lösen">✕</button>` : ""}
    </div>`;
  }

  function relRow(rel, label, person) {
    return `<div class="family-row link" data-id="${person.id}">
      <span class="family-label">${label}</span>
      <span>${esc(fullName(person))} <span class="muted">(${esc(ageText(person))})</span></span>
      <button class="rel-del" data-rel="${rel.id}" title="Beziehung löschen">✕</button>
    </div>`;
  }

  // Zurück führt dorthin, wo man hergekommen ist — Personen- oder Geburtstagsliste
  const backToList = () => (currentTab === "birthdays" ? renderBirthdays() : renderPersons());
  document.getElementById("back").addEventListener("click", backToList);
  document.getElementById("edit").addEventListener("click", () => openPersonForm(p));
  const bdayBox = document.getElementById("d-bday");
  if (bdayBox) bdayBox.addEventListener("change", e => Store.setBirthdayReminder(id, e.target.checked));
  document.getElementById("show-tree").addEventListener("click", () => renderTreeView(id));
  view.querySelectorAll(".family-row.link").forEach(row =>
    row.addEventListener("click", () => renderPersonDetail(row.dataset.id)));

  document.getElementById("add-note").addEventListener("click", () => {
    const ta = document.getElementById("new-note");
    if (ta.value.trim()) { Store.addNote(id, ta.value); renderPersonDetail(id); }
  });

  view.querySelectorAll(".note-del").forEach(btn =>
    btn.addEventListener("click", e => {
      const noteId = e.target.closest(".note").dataset.note;
      if (confirm("Diese Notiz löschen?")) { Store.deleteNote(id, noteId); renderPersonDetail(id); }
    }));

  document.getElementById("link-partner").addEventListener("click", () =>
    openPersonPicker(`Partner/in von ${fullName(p)} wählen`, other => {
      Store.setPartner(id, other.id); renderPersonDetail(id);
    }, id));

  document.getElementById("link-child").addEventListener("click", () =>
    openPersonPicker(`Kind von ${fullName(p)} wählen`, other => {
      Store.addParentChild(id, other.id); renderPersonDetail(id);
    }, id));

  document.getElementById("link-rel").addEventListener("click", () => openRelationForm(p));

  view.querySelectorAll("#detail-tags .chip").forEach(chip =>
    chip.addEventListener("click", () => {
      const tagId = chip.dataset.tag;
      if (Store.get(id).tagIds.includes(tagId)) Store.removeTagFromPerson(id, tagId);
      else Store.addTagToPerson(id, tagId);
      renderPersonDetail(id);
    }));

  view.querySelectorAll(".rel-del[data-rel]").forEach(btn =>
    btn.addEventListener("click", e => {
      e.stopPropagation();
      if (confirm("Diese Beziehung löschen?")) {
        Store.removeRelation(btn.dataset.rel);
        renderPersonDetail(id);
      }
    }));

  view.querySelectorAll(".rel-del[data-unlink]").forEach(btn =>
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const other = Store.get(btn.dataset.other);
      if (!other) return;
      const kind = btn.dataset.unlink;
      const frage = {
        partner: `Partnerschaft von ${fullName(p)} und ${fullName(other)} lösen?`,
        parent: `${fullName(other)} nicht mehr als Elternteil von ${fullName(p)} führen?`,
        child: `${fullName(other)} nicht mehr als Kind von ${fullName(p)} führen?`,
      }[kind];
      if (!confirm(frage + "\n\nBeide Personen bleiben erhalten, nur die Verknüpfung geht weg.")) return;
      if (kind === "partner") Store.removePartner(id);
      else if (kind === "parent") Store.removeParentChild(other.id, id);
      else Store.removeParentChild(id, other.id);
      renderPersonDetail(id);
    }));

  document.getElementById("delete-person").addEventListener("click", () => {
    if (confirm(`${fullName(p)} wirklich löschen? Notizen gehen verloren.`)) {
      Store.deletePerson(id);
      backToList();
    }
  });
}

// ---------- Ansicht: Stammbaum ----------

let treeZoom = 1;
let treeSize = { w: 0, h: 0 };

function renderTreeView(rootId) {
  const root = Store.get(rootId);
  if (!root) return renderPersons();
  const { svg, contentW, contentH, count, extraCount, dupCount } = renderFamilySvg(rootId);
  treeSize = { w: contentW, h: contentH };

  const hint = count === 1 && extraCount === 0
    ? `<p class="muted small-text">Für ${esc(fullName(root))} sind noch keine Familienverbindungen eingetragen. Verknüpfe Partner, Kinder oder Beziehungen auf der Personenseite.</p>`
    : `<p class="muted small-text">Eltern und alle Generationen darunter · ${count} ${count === 1 ? "Person" : "Personen"}${extraCount ? ` · ${extraCount} weitere verbunden` : ""}${dupCount ? " · ↗ = steht noch an anderer Stelle im Baum" : ""}<br>Tippe auf eine andere Person, um deren Stammbaum zu sehen — auf ${esc(root.firstName)} selbst für die Personenseite.</p>`;

  view.innerHTML = `
    <div class="tree-view">
      <div class="tree-bar">
        <button id="tree-back" class="btn ghost small">‹ Zurück</button>
        <span class="tree-title">${esc(fullName(root))}</span>
        <div class="tree-zoom">
          <button id="tree-out" class="btn ghost small">−</button>
          <button id="tree-fit" class="btn ghost small">Passend</button>
          <button id="tree-in" class="btn ghost small">+</button>
        </div>
      </div>
      ${hint}
      <div id="tree-canvas" class="tree-canvas">${svg}</div>
    </div>`;

  const canvas = document.getElementById("tree-canvas");
  // Beim Öffnen lesbar bleiben (notfalls seitlich scrollen); "Passend" zeigt die Übersicht
  const fitTo = minZoom => {
    const avail = canvas.clientWidth - 6;
    treeZoom = Math.min(1, Math.max(minZoom, avail / treeSize.w));
    applyTreeZoom();
  };
  fitTo(0.6);

  document.getElementById("tree-back").addEventListener("click", () => renderPersonDetail(rootId));
  document.getElementById("tree-fit").addEventListener("click", () => fitTo(0.2));
  document.getElementById("tree-in").addEventListener("click", () => {
    treeZoom = Math.min(2.2, treeZoom * 1.25); applyTreeZoom();
  });
  document.getElementById("tree-out").addEventListener("click", () => {
    treeZoom = Math.max(0.25, treeZoom / 1.25); applyTreeZoom();
  });

  // Andere Person → deren Stammbaum; die gewählte Person selbst → ihre Personenseite
  view.querySelectorAll(".tree-node").forEach(node =>
    node.addEventListener("click", () => {
      const id = node.dataset.id;
      if (id === rootId) renderPersonDetail(id);
      else renderTreeView(id);
    }));
}

function applyTreeZoom() {
  const svg = document.getElementById("tree-svg");
  if (!svg) return;
  svg.setAttribute("width", Math.round(treeSize.w * treeZoom));
  svg.setAttribute("height", Math.round(treeSize.h * treeZoom));
}

// ---------- Formular: Person anlegen/bearbeiten ----------

function openPersonForm(person) {
  const isNew = !person;
  const b = person?.birth;
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>${isNew ? "Neue Person" : "Person bearbeiten"}</h2>
        <label>Vorname<input id="f-first" value="${esc(person?.firstName || "")}"></label>
        <label>Nachname<input id="f-last" value="${esc(person?.lastName || "")}"></label>
        <label>Geburtsdatum (falls bekannt)<input id="f-date" type="date" value="${b?.date || ""}"></label>
        <label>… oder nur Tag und Monat<input id="f-daymonth" placeholder="z. B. 12.03."
          value="${(b?.day && b?.month) ? `${b.day}.${b.month}.` : ""}"></label>
        <div class="form-row">
          <label>… oder Geburtsjahr<input id="f-year" type="number" placeholder="z. B. 1984" value="${(!b?.date && b?.year) ? b.year : ""}"></label>
          <label>… oder Alter<input id="f-age" type="number" placeholder="z. B. 42"></label>
        </div>
        <div class="form-row">
          <label>Firma<input id="f-company" value="${esc(person?.company || "")}" placeholder="z. B. Bosch"></label>
          <label>Position<input id="f-position" value="${esc(person?.position || "")}" placeholder="z. B. Teamleiter"></label>
        </div>
        <label class="toggle-row">
          <input type="checkbox" id="f-bday" ${person?.birthdayReminder ? "checked" : ""}>
          🎂 An den Geburtstag erinnern
        </label>
        <label>Kategorien</label>
        <div class="chip-row" id="f-tags">
          ${Store.allTags().filter(t => t.id !== UNSORTED_TAG_ID).map(t =>
            `<button type="button" class="chip ${person?.tagIds?.includes(t.id) ? "active" : ""}" data-tag="${t.id}">${esc(t.name)}</button>`).join("")}
        </div>
        <details id="f-advanced" ${person?.death ? "open" : ""}>
          <summary>Erweitert</summary>
          <label class="toggle-row"><input type="checkbox" id="f-deceased" ${person?.death ? "checked" : ""}> Verstorben</label>
          <div id="f-death-fields" ${person?.death ? "" : "hidden"}>
            <label>Todesdatum (falls bekannt)<input id="f-ddate" type="date" value="${person?.death?.date || ""}"></label>
            <label>… oder Todesjahr<input id="f-dyear" type="number" placeholder="z. B. 2023" value="${(!person?.death?.date && person?.death?.year) ? person.death.year : ""}"></label>
          </div>
        </details>
        <div class="modal-actions">
          <button id="f-cancel" class="btn ghost">Abbrechen</button>
          <button id="f-save" class="btn primary">Speichern</button>
        </div>
      </div>
    </div>`;

  document.getElementById("f-cancel").addEventListener("click", closeModal);
  document.getElementById("f-deceased").addEventListener("change", e => {
    document.getElementById("f-death-fields").hidden = !e.target.checked;
  });
  modalRoot.querySelectorAll("#f-tags .chip").forEach(chip =>
    chip.addEventListener("click", () => chip.classList.toggle("active")));
  document.getElementById("f-save").addEventListener("click", () => {
    const firstName = document.getElementById("f-first").value.trim();
    if (!firstName) { alert("Bitte mindestens einen Vornamen angeben."); return; }
    const dayMonthRaw = document.getElementById("f-daymonth").value.trim();
    if (dayMonthRaw && !parseDayMonth(dayMonthRaw)) {
      alert("Tag und Monat bitte als „12.03.“ angeben.");
      return;
    }
    const fields = {
      firstName,
      lastName: document.getElementById("f-last").value.trim(),
      birthDate: document.getElementById("f-date").value || null,
      birthDayMonth: dayMonthRaw || null,
      birthYear: document.getElementById("f-year").value || null,
      ageYears: document.getElementById("f-age").value || null,
      company: document.getElementById("f-company").value.trim(),
      position: document.getElementById("f-position").value.trim(),
      deceased: document.getElementById("f-deceased").checked,
      deathDate: document.getElementById("f-deceased").checked ? (document.getElementById("f-ddate").value || null) : null,
      deathYear: document.getElementById("f-deceased").checked ? (document.getElementById("f-dyear").value || null) : null,
    };
    let target;
    if (isNew) target = Store.createPerson(fields);
    else target = Store.updatePerson(person.id, fields);
    Store.setBirthdayReminder(target.id, document.getElementById("f-bday").checked);

    const chosen = [...modalRoot.querySelectorAll("#f-tags .chip.active")].map(c => c.dataset.tag);
    for (const tagId of Store.allTags().map(t => t.id)) {
      if (tagId === UNSORTED_TAG_ID) continue;
      if (chosen.includes(tagId)) Store.addTagToPerson(target.id, tagId);
      else Store.removeTagFromPerson(target.id, tagId);
    }

    closeModal();
    renderPersonDetail(target.id);
  });
}

function openRelationForm(p) {
  const candidates = Store.all().filter(x => x.id !== p.id);
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>Beziehung für ${esc(fullName(p))}</h2>
        <label>Bezeichnung<input id="r-label" placeholder="z. B. Opa, Tante, Nachbar, Chef"></label>
        <label>Richtung</label>
        <label class="toggle-row"><input type="radio" name="r-dir" value="out" checked> ${esc(p.firstName)} ist … von der gewählten Person</label>
        <label class="toggle-row"><input type="radio" name="r-dir" value="in"> Die gewählte Person ist … von ${esc(p.firstName)}</label>
        <label style="margin-top:10px">Person wählen</label>
        <div class="picker-list">
          ${candidates.length === 0 ? `<div class="muted">Keine weiteren Personen vorhanden — lege sie zuerst an.</div>` :
            candidates.map(c => `<button class="picker-item" data-id="${c.id}">${esc(fullName(c))} <span class="muted">(${esc(ageText(c))})</span></button>`).join("")}
        </div>
        <div class="modal-actions">
          <button id="r-cancel" class="btn ghost">Abbrechen</button>
        </div>
      </div>
    </div>`;

  document.getElementById("r-cancel").addEventListener("click", closeModal);
  modalRoot.querySelectorAll(".picker-item").forEach(btn =>
    btn.addEventListener("click", () => {
      const label = document.getElementById("r-label").value.trim();
      if (!label) { alert("Bitte zuerst eine Bezeichnung eintragen (z. B. Opa)."); return; }
      const dir = modalRoot.querySelector('input[name="r-dir"]:checked').value;
      const other = Store.get(btn.dataset.id);
      if (dir === "out") Store.addRelation(p.id, other.id, label);
      else Store.addRelation(other.id, p.id, label);
      closeModal();
      renderPersonDetail(p.id);
    }));
}

function openPersonPicker(title, onPick, excludeId) {
  const candidates = Store.all().filter(p => p.id !== excludeId);
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>${esc(title)}</h2>
        <div class="picker-list">
          ${candidates.length === 0 ? `<div class="muted">Keine weiteren Personen vorhanden — lege sie zuerst an.</div>` :
            candidates.map(p => `<button class="picker-item" data-id="${p.id}">${esc(fullName(p))} <span class="muted">(${esc(ageText(p))})</span></button>`).join("")}
        </div>
        <div class="modal-actions">
          <button id="pk-cancel" class="btn ghost">Abbrechen</button>
        </div>
      </div>
    </div>`;
  document.getElementById("pk-cancel").addEventListener("click", closeModal);
  modalRoot.querySelectorAll(".picker-item").forEach(btn =>
    btn.addEventListener("click", () => {
      const p = Store.get(btn.dataset.id);
      closeModal();
      onPick(p);
    }));
}

function closeModal() { modalRoot.innerHTML = ""; }

// ---------- Ansicht: Einstellungen ----------

function renderSettings() {
  const s = Settings.data;
  view.innerHTML = `
    <div class="settings">
      <div class="card">
        <h3>Google Drive</h3>
        <p class="muted small-text">Deine Daten werden als Datei „personen-gedaechtnis.json" in deinem Google Drive gespeichert. Die App sieht nur diese eine Datei.</p>
        <label>Google Client-ID<input id="s-gcid" value="${esc(s.googleClientId)}" placeholder="…apps.googleusercontent.com"></label>
        <div class="settings-row">
          <button id="s-connect" class="btn primary">Mit Google Drive verbinden</button>
          <span id="drive-status-text" class="muted">${statusText(Drive.status, "")}</span>
        </div>
      </div>

      <div class="card">
        <h3>KI-Verstehen (Claude)</h3>
        <p class="muted small-text">Für frei formulierte Sprachbefehle. Einfache Fragen beantwortet die App auch ohne Schlüssel.</p>
        <label>Anthropic-API-Schlüssel<input id="s-akey" type="password" value="${esc(s.anthropicKey)}" placeholder="sk-ant-…"></label>
        <div class="settings-row">
          <button id="s-akey-save" class="btn primary">Schlüssel speichern</button>
          <span id="s-akey-status" class="muted">${s.anthropicKey ? "Schlüssel gespeichert ✓" : "Noch kein Schlüssel gespeichert"}</span>
        </div>
      </div>

      <div class="card">
        <h3>Kategorien</h3>
        <p class="muted small-text">Jede Person gehört zu mindestens einer Kategorie. „Unsortiert" ist das Auffangnetz und lässt sich nicht löschen.</p>
        <div id="tag-admin" class="tag-admin">
          ${Store.allTags().map(t => {
            const count = Store.personsWithTag(t.id).length;
            const locked = t.id === UNSORTED_TAG_ID;
            return `<div class="tag-admin-row" data-tag="${t.id}">
              <span class="tag-admin-name">${esc(t.name)}</span>
              <span class="muted tag-admin-count">${count}</span>
              ${locked ? `<span class="muted small-text">fest</span>` : `
                <button class="btn small ghost tag-rename">Umbenennen</button>
                <button class="btn small ghost danger tag-delete">Löschen</button>`}
            </div>`;
          }).join("")}
        </div>
        <div class="input-row" style="margin-top:10px">
          <input id="new-tag" placeholder="Neue Kategorie …">
          <button id="add-tag" class="btn primary">+</button>
        </div>
      </div>

      <div class="card">
        <h3>Geburtstags-Erinnerungen</h3>
        <p class="muted small-text">Die Geburtstage landen in einem eigenen Google-Kalender. Das Erinnern übernimmt dann der Kalender — auch wenn die App nicht offen ist.</p>
        ${Calendar.legacyDropped ? `<p class="muted small-text">⚠ Frühere Erinnerungen lagen in deinem Hauptkalender. Die App verwaltet sie dort nicht mehr — bitte lösche sie einmalig von Hand in Google Kalender.</p>` : ""}
        <label class="toggle-row">
          <input type="checkbox" id="s-cal" ${s.calendarEnabled ? "checked" : ""}>
          Geburtstage automatisch abgleichen
        </label>
        <label>Name des Kalenders
          <input id="s-cal-name" value="${esc(s.calendarName)}" placeholder="Geburtstage" readonly></label>
        <div class="settings-row">
          <button id="s-cal-name-edit" class="btn ghost small">Namen ändern</button>
        </div>
        <label>Erinnerung wie viele Tage vorher (0 = am Tag selbst)
          <input id="s-cal-lead" type="number" min="0" max="28" value="${s.calendarLeadDays}"></label>
        <p class="muted small-text">${s.calendarId
          ? "Der Kalender ist angelegt. Ein geänderter Name wird beim nächsten Abgleich übernommen."
          : "Der Kalender wird beim ersten Abgleich angelegt."}</p>
        <div class="settings-row">
          <button id="s-cal-sync" class="btn primary">Jetzt abgleichen</button>
          <button id="s-cal-reauth" class="btn ghost small">Zugriff neu erteilen</button>
        </div>
        <p id="cal-status" class="muted small-text">${Calendar.pending()} ${Calendar.pending() === 1 ? "Erinnerung" : "Erinnerungen"} aktiv</p>
      </div>

      <div class="card">
        <h3>Sprachausgabe</h3>
        <label class="toggle-row">
          <input type="checkbox" id="s-tts" ${s.ttsEnabled ? "checked" : ""}>
          Antworten vorlesen
        </label>
      </div>

      <div class="card">
        <h3>Geburtstage aus Kalender importieren</h3>
        <p class="muted small-text">Legt Personen aus einer Kalenderdatei (.ics) an. Aus dem Termintitel wird das erste Wort der Vorname, der Rest der Nachname. Google exportiert ein ZIP — daraus die .ics entpacken.</p>
        <label>Kategorie für die importierten Personen (Pflicht)
          <select id="imp-tag">
            <option value="">— bitte wählen —</option>
            ${Store.allTags().map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
          </select></label>
        <label class="toggle-row">
          <input type="checkbox" id="imp-year">
          Das Jahr in dieser Datei ist das echte Geburtsjahr
        </label>
        <p class="muted small-text">Ohne Häkchen werden nur Tag und Monat übernommen. Bei selbst angelegten Terminen ist das Jahr meist nur das Jahr der Anlage.</p>
        <div class="settings-row">
          <button id="imp-file" class="btn primary" disabled>.ics-Datei wählen</button>
          <input id="imp-input" type="file" accept=".ics,text/calendar" multiple hidden>
          <span id="imp-status" class="muted small-text">Bitte zuerst eine Kategorie wählen.</span>
        </div>
      </div>

      <div class="card">
        <h3>Datensicherung</h3>
        <div class="settings-row">
          <button id="s-export" class="btn ghost">Daten exportieren</button>
          <button id="s-import" class="btn ghost">Daten importieren</button>
          <input id="s-import-file" type="file" accept=".json" hidden>
        </div>
        <p class="muted small-text">${Store.db.persons.length} Personen gespeichert${Store.db.updatedAt ? " · Stand " + new Date(Store.db.updatedAt).toLocaleString("de-DE") : ""}</p>
      </div>
    </div>`;

  document.getElementById("s-gcid").addEventListener("input", e => Settings.set("googleClientId", e.target.value.trim()));
  document.getElementById("s-akey").addEventListener("input", e => Settings.set("anthropicKey", e.target.value.trim()));
  document.getElementById("s-akey-save").addEventListener("click", () => {
    Settings.set("anthropicKey", document.getElementById("s-akey").value.trim());
    document.getElementById("s-akey-status").textContent =
      Settings.data.anthropicKey ? "Schlüssel gespeichert ✓" : "Das Feld ist leer.";
  });
  document.getElementById("s-tts").addEventListener("change", e => Settings.set("ttsEnabled", e.target.checked));

  document.getElementById("s-cal").addEventListener("change", e =>
    Settings.set("calendarEnabled", e.target.checked));
  // Der Kalendername ist gesperrt, bis man ihn ausdrücklich ändern will —
  // er hängt an einem echten Kalender in Google, das verstellt man nicht nebenbei.
  const calName = document.getElementById("s-cal-name");
  const calNameBtn = document.getElementById("s-cal-name-edit");
  calNameBtn.addEventListener("click", () => {
    if (calName.readOnly) {
      calName.readOnly = false;
      calName.focus();
      calName.select();
      calNameBtn.textContent = "Übernehmen";
      return;
    }
    const neu = calName.value.trim();
    if (!neu) { alert("Bitte einen Namen für den Kalender angeben."); calName.focus(); return; }
    Settings.set("calendarName", neu);
    calName.value = neu;
    calName.readOnly = true;
    calNameBtn.textContent = "Namen ändern";
  });
  calName.addEventListener("keydown", e => {
    if (e.key === "Enter" && !calName.readOnly) { e.preventDefault(); calNameBtn.click(); }
  });
  document.getElementById("s-cal-lead").addEventListener("change", e => {
    const days = Math.max(0, Math.min(28, Number(e.target.value) || 0));
    e.target.value = days;
    Settings.set("calendarLeadDays", days);
  });
  async function runCalendarSync(forceConsent) {
    const status = document.getElementById("cal-status");
    Settings.set("googleClientId", document.getElementById("s-gcid").value.trim());
    if (!Settings.data.googleClientId) { alert("Bitte zuerst die Google Client-ID eintragen."); return; }
    status.textContent = forceConsent ? "Frage Zugriff neu an …" : "Gleiche ab …";
    try {
      const r = await Calendar.sync(true, forceConsent);
      Settings.set("calendarEnabled", true);
      const zusammenfassung = `${r.angelegt} neu · ${r.aktualisiert} aktualisiert · ${r.entfernt} entfernt`;
      renderSettings(); // Kalendername/-status in der Ansicht nachziehen
      document.getElementById("cal-status").textContent =
        zusammenfassung + (r.warnungen.length ? " — " + r.warnungen.join(" ") : "");
    } catch (e) {
      status.textContent = "Fehler: " + e.message;
    }
  }

  document.getElementById("s-cal-sync").addEventListener("click", () => runCalendarSync(false));
  document.getElementById("s-cal-reauth").addEventListener("click", () => runCalendarSync(true));

  const newTagInput = document.getElementById("new-tag");
  document.getElementById("add-tag").addEventListener("click", () => {
    if (!newTagInput.value.trim()) return;
    Store.createTag(newTagInput.value);
    renderSettings();
  });
  newTagInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("add-tag").click(); }
  });

  view.querySelectorAll(".tag-rename").forEach(btn =>
    btn.addEventListener("click", () => {
      const row = btn.closest(".tag-admin-row");
      const tag = Store.getTag(row.dataset.tag);
      const name = prompt(`Kategorie „${tag.name}" umbenennen in:`, tag.name);
      if (name && name.trim()) { Store.renameTag(tag.id, name); renderSettings(); }
    }));

  view.querySelectorAll(".tag-delete").forEach(btn =>
    btn.addEventListener("click", () => {
      const row = btn.closest(".tag-admin-row");
      const tag = Store.getTag(row.dataset.tag);
      const count = Store.personsWithTag(tag.id).length;
      const warn = count
        ? `\n\n${count} ${count === 1 ? "Person verliert" : "Personen verlieren"} diese Kategorie; wer danach keine mehr hat, wird „Unsortiert".`
        : "";
      if (confirm(`Kategorie „${tag.name}" löschen?${warn}`)) { Store.deleteTag(tag.id); renderSettings(); }
    }));

  document.getElementById("s-connect").addEventListener("click", async () => {
    Settings.set("googleClientId", document.getElementById("s-gcid").value.trim());
    if (!Settings.data.googleClientId) { alert("Bitte zuerst die Google Client-ID eintragen."); return; }
    await Drive.connect(true);
  });

  // ---- Import aus Kalenderdatei ----
  const impTag = document.getElementById("imp-tag");
  const impFile = document.getElementById("imp-file");
  const impInput = document.getElementById("imp-input");
  const impStatus = document.getElementById("imp-status");

  // Ohne Kategorie wird nicht importiert — der Knopf bleibt gesperrt, damit
  // niemand erst eine Datei aussucht und dann abgewiesen wird.
  const chosenTag = () => (impTag.value ? Store.getTag(impTag.value) : null);
  function refreshImportState() {
    const tag = chosenTag();
    impFile.disabled = !tag;
    impStatus.textContent = tag
      ? `Importierte Personen kommen nach „${tag.name}“.`
      : "Bitte zuerst eine Kategorie wählen.";
  }
  impTag.addEventListener("change", refreshImportState);
  refreshImportState();

  impFile.addEventListener("click", () => impInput.click());
  impInput.addEventListener("change", async () => {
    const files = [...impInput.files];
    impInput.value = ""; // damit dieselbe Datei erneut gewählt werden kann
    if (!files.length) return;

    const tag = chosenTag();
    if (!tag) return;
    const nimmJahr = document.getElementById("imp-year").checked;

    let angelegt = 0, uebersprungen = 0;
    try {
      for (const file of files) {
        for (const ev of parseIcs(await file.text())) {
          const { firstName, lastName } = nameFromSummary(ev.summary);
          if (!firstName) { uebersprungen++; continue; }
          const p = Store.createPerson({
            firstName, lastName,
            ...(nimmJahr
              ? { birthDate: `${ev.year}-${String(ev.month).padStart(2, "0")}-${String(ev.day).padStart(2, "0")}` }
              : { birthDayMonth: `${ev.day}.${ev.month}.` }),
          });
          Store.addTagToPerson(p.id, tag.id);
          angelegt++;
        }
      }
    } catch (e) {
      impStatus.textContent = "Datei konnte nicht gelesen werden: " + e.message;
      return;
    }
    renderSettings();
    document.getElementById("imp-status").textContent =
      `${angelegt} ${angelegt === 1 ? "Person" : "Personen"} nach „${tag.name}“ importiert` +
      (uebersprungen ? ` · ${uebersprungen} ohne verwertbaren Namen übersprungen` : "");
  });

  document.getElementById("s-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(Store.db, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "personen-gedaechtnis-backup.json";
    a.click();
  });

  const importFile = document.getElementById("s-import-file");
  document.getElementById("s-import").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.persons)) throw new Error("Ungültiges Format");
      if (confirm(`${data.persons.length} Personen importieren? Ersetzt den aktuellen Datenbestand.`)) {
        Store.replaceDb(data);
        Store.save(); // als neueste Version markieren, damit Drive sie übernimmt
        renderSettings();
      }
    } catch (e) { alert("Datei konnte nicht gelesen werden: " + e.message); }
  });
}

// ---------- Hilfsfunktionen ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Start ----------

render();
if (Drive.configured()) Drive.connect(false); // stiller Verbindungsversuch

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
