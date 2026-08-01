// google.js — gemeinsame Google-Anmeldung für Drive und Kalender.
//
// Pro Berechtigung (Scope) ein eigener Token-Client: wer nur Drive nutzt,
// wird nie nach Kalenderrechten gefragt. Tokens werden je Scope zwischen-
// gespeichert und kurz vor Ablauf erneuert.
"use strict";

import { Settings } from "./store.js";

export const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";
// calendar.app.created statt des breiteren calendar.events: erlaubt genau das,
// was die App braucht — einen eigenen Kalender anlegen, umbenennen, einfärben
// und dessen Termine verwalten. Auf andere Kalender kommt sie damit nicht.
export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.app.created";

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

// interactive=true zeigt notfalls das Google-Anmeldefenster.
// forceConsent=true erzwingt den Zustimmungsdialog und verwirft den
// zwischengespeicherten Token — nötig, wenn sich die angeforderten Rechte
// geändert haben, denn eine ältere Freigabe deckt den neuen Scope nicht ab.
export async function getToken(scope, interactive, forceConsent = false) {
  const entry = clients.get(scope) || {};
  if (!forceConsent && entry.token && Date.now() < entry.expiry - 60_000) return entry.token;
  if (forceConsent) entry.token = null;
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
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      // Ohne diese Prüfung ginge „Bearer undefined“ an Google und käme als
      // wenig aussagekräftiges 401 zurück.
      if (!resp.access_token) {
        return reject(new Error(
          "Google hat keinen Zugriffstoken geliefert. Wurde das Anmeldefenster " +
          "geschlossen oder vom Browser als Pop-up blockiert?"));
      }
      entry.token = resp.access_token;
      entry.expiry = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve(entry.token);
    };
    try {
      entry.client.requestAccessToken({
        prompt: forceConsent ? "consent" : interactive ? "" : "none",
      });
    } catch (e) { reject(e); }
  });
}

// Google-Fehler in etwas übersetzen, mit dem man auch etwas anfangen kann
function describe(status, path, text) {
  const endpoint = path.split("?")[0];
  if (status === 401) {
    return `401 bei ${endpoint} — Google hat die Anmeldung abgelehnt. ` +
      `Meist hilft „Zugriff neu erteilen“: nach geänderten Berechtigungen ist die alte Freigabe ungültig.`;
  }
  if (status === 403) {
    return `403 bei ${endpoint} — Zugriff verweigert. Prüfe, ob die Google-Kalender-API aktiviert ` +
      `und der Scope im OAuth-Zustimmungsbildschirm eingetragen ist. (${text.slice(0, 120)})`;
  }
  return `${status} bei ${endpoint}: ${text.slice(0, 200)}`;
}

// Erst lautlos anmelden, erst bei Bedarf das Anmeldefenster zeigen.
export async function api(scope, path, options = {}) {
  const token = await getToken(scope, false).catch(() => getToken(scope, true));
  const resp = await fetch("https://www.googleapis.com" + path, {
    ...options,
    headers: { Authorization: "Bearer " + token, ...(options.headers || {}) },
  });
  if (!resp.ok) throw new Error(describe(resp.status, path, await resp.text()));
  return resp;
}
