// app.js — Oberfläche und Navigation
"use strict";

import { Store, Settings, ageText, fullName } from "./store.js";
import { handleInput } from "./nlu.js";
import { Drive } from "./drive.js";
import { speak, stopSpeaking } from "./speech.js";

Store.load();
Settings.load();

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
  else if (currentTab === "settings") renderSettings();
}

Store.onChange(() => { if (currentTab === "persons") renderPersons(); });

// ---------- Drive-Status ----------

Drive.onStatus((status, detail) => {
  const map = { getrennt: "#999", verbinde: "#e6a817", verbunden: "#2eae5d", fehler: "#d64545" };
  syncStatus.style.color = map[status] || "#999";
  syncStatus.title = "Google Drive: " + status + (detail ? " — " + detail : "");
  const el = document.getElementById("drive-status-text");
  if (el) el.textContent = statusText(status, detail);
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

function renderPersons(detailId = null) {
  if (detailId) return renderPersonDetail(detailId);

  const persons = Store.all();
  view.innerHTML = `
    <div class="persons">
      <div class="toolbar">
        <input id="search" type="search" placeholder="Suchen …">
        <button id="add-person" class="btn primary">+ Neu</button>
      </div>
      <div id="person-list" class="person-list"></div>
    </div>`;

  const list = document.getElementById("person-list");
  const search = document.getElementById("search");

  function draw(filter = "") {
    const items = filter ? Store.findByName(filter) : persons;
    if (items.length === 0) {
      list.innerHTML = `<div class="empty">${filter ? `Keine Treffer.` : `Noch keine Personen.<br>Lege die erste über „+ Neu“ oder den Assistenten an.`}</div>`;
      return;
    }
    list.innerHTML = items.map(p => {
      const partner = Store.partnerOf(p.id);
      const kids = Store.childrenOf(p.id);
      const sub = [
        ageText(p),
        partner ? "♥ " + fullName(partner) : null,
        kids.length ? kids.length + (kids.length === 1 ? " Kind" : " Kinder") : null,
        p.notes.length ? "📝 " + p.notes.length : null,
      ].filter(Boolean).join(" · ");
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
}

function renderPersonDetail(id) {
  const p = Store.get(id);
  if (!p) return renderPersons();
  const partner = Store.partnerOf(id);
  const kids = Store.childrenOf(id);
  const parents = Store.parentsOf(id);

  view.innerHTML = `
    <div class="detail">
      <button id="back" class="btn ghost">‹ Zurück</button>
      <div class="card">
        <div class="detail-head">
          <h2>${esc(fullName(p))}</h2>
          <button id="edit" class="btn small">Bearbeiten</button>
        </div>
        <div class="detail-age">${esc(ageText(p))}${p.birth?.date ? " · geb. " + new Date(p.birth.date + "T00:00:00").toLocaleDateString("de-DE") : (p.birth?.year ? " · Jahrgang " + p.birth.year : "")}</div>

        <h3>Familie</h3>
        <div class="family">
          ${partner ? linkRow("♥ Partner/in", partner) : `<div class="family-row muted">Kein Partner eingetragen</div>`}
          ${parents.map(par => linkRow("↑ Elternteil", par)).join("")}
          ${kids.map(k => linkRow("↓ Kind", k)).join("")}
        </div>
        <div class="family-actions">
          <button id="link-partner" class="btn small ghost">Partner verknüpfen</button>
          <button id="link-child" class="btn small ghost">Kind verknüpfen</button>
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

  function linkRow(label, person) {
    return `<div class="family-row link" data-id="${person.id}">
      <span class="family-label">${label}</span>
      <span>${esc(fullName(person))} <span class="muted">(${esc(ageText(person))})</span></span>
    </div>`;
  }

  document.getElementById("back").addEventListener("click", () => renderPersons());
  document.getElementById("edit").addEventListener("click", () => openPersonForm(p));
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

  document.getElementById("delete-person").addEventListener("click", () => {
    if (confirm(`${fullName(p)} wirklich löschen? Notizen gehen verloren.`)) {
      Store.deletePerson(id);
      renderPersons();
    }
  });
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
        <div class="form-row">
          <label>… oder Geburtsjahr<input id="f-year" type="number" placeholder="z. B. 1984" value="${(!b?.date && b?.year) ? b.year : ""}"></label>
          <label>… oder Alter<input id="f-age" type="number" placeholder="z. B. 42"></label>
        </div>
        <div class="modal-actions">
          <button id="f-cancel" class="btn ghost">Abbrechen</button>
          <button id="f-save" class="btn primary">Speichern</button>
        </div>
      </div>
    </div>`;

  document.getElementById("f-cancel").addEventListener("click", closeModal);
  document.getElementById("f-save").addEventListener("click", () => {
    const firstName = document.getElementById("f-first").value.trim();
    if (!firstName) { alert("Bitte mindestens einen Vornamen angeben."); return; }
    const fields = {
      firstName,
      lastName: document.getElementById("f-last").value.trim(),
      birthDate: document.getElementById("f-date").value || null,
      birthYear: document.getElementById("f-year").value || null,
      ageYears: document.getElementById("f-age").value || null,
    };
    let target;
    if (isNew) target = Store.createPerson(fields);
    else target = Store.updatePerson(person.id, fields);
    closeModal();
    renderPersonDetail(target.id);
  });
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
        <h3>Sprachausgabe</h3>
        <label class="toggle-row">
          <input type="checkbox" id="s-tts" ${s.ttsEnabled ? "checked" : ""}>
          Antworten vorlesen
        </label>
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

  document.getElementById("s-connect").addEventListener("click", async () => {
    Settings.set("googleClientId", document.getElementById("s-gcid").value.trim());
    if (!Settings.data.googleClientId) { alert("Bitte zuerst die Google Client-ID eintragen."); return; }
    await Drive.connect(true);
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
