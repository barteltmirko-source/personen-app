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
// anlegt; den Namen bestimmt der Nutzer. Dadurch lassen sie sich in Google mit
// einem Haken ein- und ausblenden, und der Hauptkalender bleibt unberührt —
// der Scope calendar.app.created gibt der App ohnehin nur Zugriff auf
// Kalender, die sie selbst erzeugt hat.
//
// Die Farbe vergibt der Nutzer in Google Kalender selbst. Sie sitzt dort am
// Eintrag in der Kalenderliste, und den anzufassen würde eine zusätzliche
// Berechtigung auf die gesamte Kalenderliste kosten — zu viel für Kosmetik.
"use strict";

import { Store, Settings, fullName, hasBirthday, birthDayMonthOf } from "./store.js";
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

// Google zählt die Vorwarnzeit in Minuten vor Mitternacht des Termintags.
// 0 Tage vorher = Mitternacht, sonst 9 Uhr morgens am jeweiligen Tag.
function reminderMinutes(leadDays) {
  const days = Math.max(0, Math.min(28, Number(leadDays) || 0));
  return days === 0 ? 0 : days * 1440 - 540;
}

function eventBody(person) {
  const { day: d, month: m } = birthDayMonthOf(person);
  // Ist kein Geburtsjahr bekannt, ist das Startjahr der Serie beliebig — die
  // jährliche Wiederholung trifft den Tag trotzdem.
  const y = person.birth.year || new Date().getFullYear();
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
    }

    return id;
  },

  // Der Name ist Beiwerk — die Termine sind der Zweck. Ein Fehlschlag beim
  // Umbenennen darf den Abgleich deshalb nicht abbrechen, sondern wird nur
  // gemeldet und beim nächsten Mal erneut versucht.
  async applyName(id) {
    const name = calendarName();
    if (Settings.data.calendarAppliedName === name) return [];
    try {
      await api(SCOPE_CALENDAR, calPath(id), { method: "PATCH", ...json({ summary: name }) });
      Settings.set("calendarAppliedName", name);
      return [];
    } catch (e) {
      return ["Der Kalendername konnte nicht übernommen werden."];
    }
  },

  async sync(interactive = false, forceConsent = false) {
    if (!this.configured()) throw new Error("Keine Google Client-ID hinterlegt");
    await getToken(SCOPE_CALENDAR, interactive || forceConsent, forceConsent);
    const calId = await this.ensureCalendar();
    const events = `${calPath(calId)}/events`;
    // Zuerst die Termine, danach der Name — so kostet ein Problem beim
    // Umbenennen nie die Erinnerungen selbst.
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
    // Termine gelöschter Personen: Die Person ist weg, also läuft sie in der
    // Schleife oben nicht mehr mit — ohne diese Liste bliebe ihr Geburtstag
    // für immer im Kalender stehen.
    for (const eventId of Store.calendarOrphans()) {
      try {
        await api(SCOPE_CALENDAR, `${events}/${enc(eventId)}`, { method: "DELETE" });
      } catch (e) { /* schon weg — auch gut */ }
      Store.dropCalendarOrphan(eventId);
      entfernt++;
    }

    const warnungen = await this.applyName(calId);
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
