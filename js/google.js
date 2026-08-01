// google.js — gemeinsame Google-Anmeldung für Drive und Kalender.
//
// Pro Berechtigung (Scope) ein eigener Token-Client: wer nur Drive nutzt,
// wird nie nach Kalenderrechten gefragt. Tokens werden je Scope zwischen-
// gespeichert und kurz vor Ablauf erneuert.
"use strict";

import { Settings } from "./store.js";

export const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";
export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.events";

const clients = new Map(); // scope -> { client, clientId, token, expiry }

export async function loadGis() {
  if (window.google?.accounts?.oauth2) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Google-Anmeldedienst nicht erreichbar"));
    document.head.appendChild(s);
  });
}

// interactive=true zeigt notfalls das Google-Anmeldefenster
export async function getToken(scope, interactive) {
  const entry = clients.get(scope) || {};
  if (entry.token && Date.now() < entry.expiry - 60_000) return entry.token;
  await loadGis();
  // Bei geänderter Client-ID muss der Client neu gebaut werden, sonst hängt
  // die Anmeldung weiter an der alten ID.
  if (!entry.client || entry.clientId !== Settings.data.googleClientId) {
    entry.clientId = Settings.data.googleClientId;
    entry.token = null;
    entry.client = google.accounts.oauth2.initTokenClient({
      client_id: entry.clientId,
      scope,
      callback: () => {},
    });
  }
  clients.set(scope, entry);

  return await new Promise((resolve, reject) => {
    entry.client.callback = resp => {
      if (resp.error) return reject(new Error(resp.error));
      entry.token = resp.access_token;
      entry.expiry = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve(entry.token);
    };
    try {
      entry.client.requestAccessToken({ prompt: interactive ? "" : "none" });
    } catch (e) { reject(e); }
  });
}

// Erst lautlos anmelden, erst bei Bedarf das Anmeldefenster zeigen.
export async function api(scope, path, options = {}) {
  const token = await getToken(scope, false).catch(() => getToken(scope, true));
  const resp = await fetch("https://www.googleapis.com" + path, {
    ...options,
    headers: { Authorization: "Bearer " + token, ...(options.headers || {}) },
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp;
}
