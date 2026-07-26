// drive.js — Synchronisation mit Google Drive (eine JSON-Datei, "letzter gewinnt")
"use strict";

import { Store, Settings } from "./store.js";

const FILE_NAME = "personen-gedaechtnis.json";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

// Eingerückt schreiben, damit die Datei in Drive lesbar bleibt
function serialize() { return JSON.stringify(Store.db, null, 2); }

export const Drive = {
  token: null,
  tokenExpiry: 0,
  tokenClient: null,
  status: "getrennt", // getrennt | verbinde | verbunden | fehler
  statusListeners: [],
  saveTimer: null,

  onStatus(fn) { this.statusListeners.push(fn); },
  setStatus(s, detail = "") {
    this.status = s;
    this.statusListeners.forEach(fn => fn(s, detail));
  },

  configured() { return !!Settings.data.googleClientId; },

  async loadGis() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Google-Anmeldedienst nicht erreichbar"));
      document.head.appendChild(s);
    });
  },

  // interactive=true zeigt notfalls das Google-Anmeldefenster
  async getToken(interactive) {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token;
    await this.loadGis();
    if (!this.tokenClient) {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: Settings.data.googleClientId,
        scope: SCOPE,
        callback: () => {},
      });
    }
    return await new Promise((resolve, reject) => {
      this.tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        this.token = resp.access_token;
        this.tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        resolve(this.token);
      };
      try {
        this.tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" });
      } catch (e) { reject(e); }
    });
  },

  async api(path, options = {}) {
    const token = await this.getToken(false).catch(() => this.getToken(true));
    const resp = await fetch("https://www.googleapis.com" + path, {
      ...options,
      headers: { Authorization: "Bearer " + token, ...(options.headers || {}) },
    });
    if (!resp.ok) throw new Error(`Drive-Fehler ${resp.status}: ${await resp.text()}`);
    return resp;
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
