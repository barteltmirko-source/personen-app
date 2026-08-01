// drive.js — Synchronisation mit Google Drive (eine JSON-Datei, "letzter gewinnt")
"use strict";

import { Store, Settings } from "./store.js";
import { SCOPE_DRIVE, getToken, api as googleApi } from "./google.js";

const FILE_NAME = "personen-gedaechtnis.json";

// Eingerückt schreiben, damit die Datei in Drive lesbar bleibt
function serialize() { return JSON.stringify(Store.db, null, 2); }

export const Drive = {
  status: "getrennt", // getrennt | verbinde | verbunden | fehler
  statusListeners: [],
  saveTimer: null,

  onStatus(fn) { this.statusListeners.push(fn); },
  setStatus(s, detail = "") {
    this.status = s;
    this.statusListeners.forEach(fn => fn(s, detail));
  },

  configured() { return !!Settings.data.googleClientId; },

  getToken(interactive) { return getToken(SCOPE_DRIVE, interactive); },

  async api(path, options = {}) {
    try {
      return await googleApi(SCOPE_DRIVE, path, options);
    } catch (e) {
      throw new Error("Drive-Fehler " + e.message);
    }
  },

  async findFile() {
    if (Settings.data.driveFileId) return Settings.data.driveFileId;
    const q = encodeURIComponent(`name = '${FILE_NAME}' and trashed = false`);
    const resp = await this.api(`/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`);
    const data = await resp.json();
    if (data.files?.length) {
      Settings.set("driveFileId", data.files[0].id);
      return data.files[0].id;
    }
    return null;
  },

  async createFile() {
    const metadata = { name: FILE_NAME, mimeType: "application/json" };
    const body = new FormData();
    body.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    body.append("file", new Blob([serialize()], { type: "application/json" }));
    const resp = await this.api("/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST", body,
    });
    const data = await resp.json();
    Settings.set("driveFileId", data.id);
    return data.id;
  },

  async download(fileId) {
    const resp = await this.api(`/drive/v3/files/${fileId}?alt=media`);
    return await resp.json();
  },

  async upload(fileId) {
    await this.api(`/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: serialize(),
    });
  },

  // Verbinden: Datei suchen/anlegen, neueren Stand übernehmen ("letzter gewinnt")
  async connect(interactive = true) {
    if (!this.configured()) { this.setStatus("getrennt", "Keine Client-ID hinterlegt"); return false; }
    this.setStatus("verbinde");
    try {
      await this.getToken(interactive);
      let fileId = await this.findFile();
      if (!fileId) {
        fileId = await this.createFile();
        this.setStatus("verbunden", "Neue Datei in Drive angelegt");
        return true;
      }
      const remote = await this.download(fileId);
      const localTime = Store.db.updatedAt ? Date.parse(Store.db.updatedAt) : 0;
      const remoteTime = remote?.updatedAt ? Date.parse(remote.updatedAt) : 0;
      if (remoteTime > localTime) {
        Store.replaceDb(remote);
        this.setStatus("verbunden", "Daten aus Drive übernommen");
      } else if (localTime > remoteTime) {
        await this.upload(fileId);
        this.setStatus("verbunden", "Lokale Daten nach Drive hochgeladen");
      } else {
        this.setStatus("verbunden");
      }
      return true;
    } catch (e) {
      console.error(e);
      this.setStatus("fehler", e.message);
      return false;
    }
  },

  // Nach jeder Änderung: verzögert speichern (bündelt schnelle Folgeänderungen)
  scheduleSave() {
    if (!this.configured() || this.status !== "verbunden") return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        const fileId = Settings.data.driveFileId || await this.findFile() || await this.createFile();
        await this.upload(fileId);
        this.setStatus("verbunden", "Gespeichert " + new Date().toLocaleTimeString("de-DE"));
      } catch (e) {
        console.error(e);
        this.setStatus("fehler", "Speichern fehlgeschlagen: " + e.message);
      }
    }, 1500);
  },
};

// Automatisch nach Drive speichern, wenn sich Daten ändern
Store.onChange((db, dirty) => { if (dirty) Drive.scheduleSave(); });
