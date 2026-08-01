// calendar.js — Geburtstage als jährlich wiederkehrende Termine in einem
// eigenen Google-Kalender.
//
// Warum überhaupt der Kalender: Eine reine Web-App kann sich nicht selbst zu
// einem Zeitpunkt aufwecken. Die dafür gedachte Browser-Schnittstelle
// (Notification Triggers) wurde von Google eingestellt, und echtes Web Push
// braucht zwingend einen Server, der die Nachricht signiert und verschickt —
// den gibt es hier bewusst nicht. Der Kalender erinnert dagegen zuverlässig,
// auch offline und ohne dass die App je geöffnet wird.
//
// Die Geburtstage landen in einem separaten Kalender, den die App selbst
// anlegt (Name und Farbe bestimmt der Nutzer). Dadurch lassen sie sich in
// Google mit einem Haken ein- und ausblenden, und der Hauptkalender bleibt
// unberührt — der Scope calendar.app.created gibt der App ohnehin nur Zugriff
// auf Kalender, die sie selbst erzeugt hat.
"use strict";

import { Store, Settings, fullName, hasBirthday } from "./store.js";
import { SCOPE_CALENDAR, getToken, api } from "./google.js";

const enc = encodeURIComponent;
const calPath = id => `/calendar/v3/calendars/${enc(id)}`;

const isoDate = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const json = body => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const calendarName = () => (Settings.data.calendarName || "").trim() || "Geburtstage";

// Schrift auf der Kalenderfarbe: dunkel auf hellem Grund, sonst weiß
function contrastOn(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#000000" : "#ffffff";
}

// Google zählt die Vorwarnzeit in Minuten vor Mitternacht des Termintags.
// 0 Tage vorher = Mitternacht, sonst 9 Uhr morgens am jeweiligen Tag.
function reminderMinutes(leadDays) {
  const days = Math.max(0, Math.min(28, Number(leadDays) || 0));
  return days === 0 ? 0 : days * 1440 - 540;
}

function eventBody(person) {
  const [y, m, d] = person.birth.date.split("-").map(Number);
  return {
    summary: `🎂 ${fullName(person)}`,
    description: "Angelegt von der App „Personen-Gedächtnis“.",
    start: { date: isoDate(new Date(y, m - 1, d)) },
    end: { date: isoDate(new Date(y, m - 1, d + 1)) },
    recurrence: ["RRULE:FREQ=YEARLY"],
    transparency: "transparent", // blockiert den Tag nicht als „beschäftigt“
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: reminderMinutes(Settings.data.calendarLeadDays) }],
    },
  };
}

export const Calendar = {
  status: "getrennt", // getrennt | synchronisiert | fehler
  statusListeners: [],
  syncTimer: null,
  legacyDropped: false,

  onStatus(fn) { this.statusListeners.push(fn); },
  setStatus(s, detail = "") {
    this.status = s;
    this.statusListeners.forEach(fn => fn(s, detail));
  },

  configured() { return !!Settings.data.googleClientId; },

  pending() {
    return Store.db.persons.filter(p => p.birthdayReminder && hasBirthday(p)).length;
  },

  // Erinnerung gewünscht, aber ohne volles Geburtsdatum nicht machbar
  incomplete() {
    return Store.db.persons.filter(p => p.birthdayReminder && !hasBirthday(p) && !p.death);
  },

  // Frühere Fassungen schrieben in den Hauptkalender. Mit dem eingeschränkten
  // Scope kommt die App an diese Termine nicht mehr heran, die Verweise wären
  // also nur irreführend. Muss nach Store.load()/Settings.load() laufen.
  dropLegacyEvents() {
    if (Settings.data.calendarId) return false;
    const stale = Store.db.persons.filter(p => p.calendarEventId);
    if (!stale.length) return false;
    for (const p of stale) Store.setCalendarEventId(p.id, null);
    this.legacyDropped = true;
    return true;
  },

  // Legt den Kalender an, falls es ihn noch nicht gibt, und zieht Name und
  // Farbe nach, wenn der Nutzer sie geändert hat.
  async ensureCalendar() {
    let id = Settings.data.calendarId;

    if (id) {
      try {
        await api(SCOPE_CALENDAR, calPath(id));
      } catch (e) {
        // In Google gelöscht → neu anlegen; die alten Termin-IDs sind wertlos
        id = "";
        Settings.set("calendarId", "");
        Settings.set("calendarAppliedName", "");
        Settings.set("calendarAppliedColor", "");
        for (const p of Store.db.persons) Store.setCalendarEventId(p.id, null);
      }
    }

    if (!id) {
      const resp = await api(SCOPE_CALENDAR, "/calendar/v3/calendars", {
        method: "POST",
        ...json({
          summary: calendarName(),
          description: "Geburtstage aus der App „Personen-Gedächtnis“.",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      id = (await resp.json()).id;
      Settings.set("calendarId", id);
      Settings.set("calendarAppliedName", calendarName());
      Settings.set("calendarAppliedColor", ""); // Farbe gleich unten setzen
    }

    return id;
  },

  // Name und Farbe sind Beiwerk — die Termine sind der Zweck. Scheitert eines
  // von beidem (etwa weil die Berechtigung für die Kalenderliste fehlt), darf
  // das den Abgleich nicht abbrechen; es wird nur gemeldet.
  async applyNameAndColor(id) {
    const warnungen = [];

    const name = calendarName();
    if (Settings.data.calendarAppliedName !== name) {
      try {
        await api(SCOPE_CALENDAR, calPath(id), { method: "PATCH", ...json({ summary: name }) });
        Settings.set("calendarAppliedName", name);
      } catch (e) {
        warnungen.push("Der Kalendername konnte nicht übernommen werden.");
      }
    }

    const color = Settings.data.calendarColor;
    if (color && Settings.data.calendarAppliedColor !== color) {
      try {
        // colorRgbFormat=true erlaubt freie Farben statt Googles fester Palette
        await api(SCOPE_CALENDAR, `/calendar/v3/users/me/calendarList/${enc(id)}?colorRgbFormat=true`, {
          method: "PATCH",
          ...json({ backgroundColor: color, foregroundColor: contrastOn(color) }),
        });
        Settings.set("calendarAppliedColor", color);
      } catch (e) {
        warnungen.push(
          "Die Farbe konnte nicht gesetzt werden — dafür fehlt die Berechtigung für die " +
          "Kalenderliste. Trage den Scope calendar.calendarlist in der Cloud Console ein " +
          "und erteile den Zugriff neu.");
      }
    }
    return warnungen;
  },

  async sync(interactive = false, forceConsent = false) {
    if (!this.configured()) throw new Error("Keine Google Client-ID hinterlegt");
    await getToken(SCOPE_CALENDAR, interactive || forceConsent, forceConsent);
    const calId = await this.ensureCalendar();
    const events = `${calPath(calId)}/events`;
    // Zuerst die Termine, danach die Kosmetik — so kostet ein Problem mit
    // Name oder Farbe nie die Erinnerungen selbst.
    let angelegt = 0, aktualisiert = 0, entfernt = 0;
    for (const p of Store.db.persons) {
      if (p.birthdayReminder && hasBirthday(p)) {
        if (p.calendarEventId) {
          try {
            await api(SCOPE_CALENDAR, `${events}/${enc(p.calendarEventId)}`,
              { method: "PATCH", ...json(eventBody(p)) });
            aktualisiert++;
            continue;
          } catch (e) {
            Store.setCalendarEventId(p.id, null); // im Kalender gelöscht → neu anlegen
          }
        }
        const resp = await api(SCOPE_CALENDAR, events, { method: "POST", ...json(eventBody(p)) });
        Store.setCalendarEventId(p.id, (await resp.json()).id);
        angelegt++;
      } else if (p.calendarEventId) {
        try {
          await api(SCOPE_CALENDAR, `${events}/${enc(p.calendarEventId)}`, { method: "DELETE" });
        } catch (e) { /* schon weg — auch gut */ }
        Store.setCalendarEventId(p.id, null);
        entfernt++;
      }
    }
    const warnungen = await this.applyNameAndColor(calId);
    return { angelegt, aktualisiert, entfernt, warnungen };
  },

  // Nach Änderungen verzögert abgleichen, damit schnelle Folgeänderungen
  // gebündelt werden.
  scheduleSync() {
    if (!Settings.data.calendarEnabled || !this.configured()) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(async () => {
      try {
        const r = await this.sync(false);
        this.setStatus("synchronisiert",
          `${r.angelegt} neu, ${r.aktualisiert} aktualisiert, ${r.entfernt} entfernt`
          + (r.warnungen.length ? " — " + r.warnungen.join(" ") : ""));
      } catch (e) {
        console.error(e);
        this.setStatus("fehler", e.message);
      }
    }, 3000);
  },
};

Store.onChange((db, dirty) => { if (dirty) Calendar.scheduleSync(); });
