// calendar.js — Geburtstage als jährlich wiederkehrende Termine im Google Kalender.
//
// Warum überhaupt der Kalender: Eine reine Web-App kann sich nicht selbst zu
// einem Zeitpunkt aufwecken. Die dafür gedachte Browser-Schnittstelle
// (Notification Triggers) wurde von Google eingestellt, und echtes Web Push
// braucht zwingend einen Server, der die Nachricht signiert und verschickt —
// den gibt es hier bewusst nicht. Der Kalender erinnert dagegen zuverlässig,
// auch offline und ohne dass die App je geöffnet wird.
//
// Die App verwaltet ausschließlich Termine, die sie selbst angelegt hat: die
// zugehörige Termin-ID steht bei der Person. Was sie nicht angelegt hat,
// fasst sie auch nicht an.
"use strict";

import { Store, Settings, fullName, hasBirthday } from "./store.js";
import { SCOPE_CALENDAR, getToken, api } from "./google.js";

const CAL = "primary";
const base = `/calendar/v3/calendars/${CAL}/events`;

const isoDate = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Google zählt die Vorwarnzeit in Minuten vor Mitternacht des Termintags.
// 0 Tage vorher = Mitternacht, sonst 9 Uhr morgens am jeweiligen Tag.
function reminderMinutes(leadDays) {
  const days = Math.max(0, Math.min(28, Number(leadDays) || 0));
  return days === 0 ? 0 : days * 1440 - 540;
}

function eventBody(person) {
  const [y, m, d] = person.birth.date.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return {
    summary: `🎂 ${fullName(person)}`,
    description: "Angelegt von der App „Personen-Gedächtnis“.",
    start: { date: isoDate(start) },
    end: { date: isoDate(end) },
    recurrence: ["RRULE:FREQ=YEARLY"],
    transparency: "transparent", // blockiert den Tag nicht als „beschäftigt“
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: reminderMinutes(Settings.data.calendarLeadDays) }],
    },
  };
}

const json = body => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const Calendar = {
  status: "getrennt", // getrennt | synchronisiert | fehler
  statusListeners: [],
  syncTimer: null,

  onStatus(fn) { this.statusListeners.push(fn); },
  setStatus(s, detail = "") {
    this.status = s;
    this.statusListeners.forEach(fn => fn(s, detail));
  },

  configured() { return !!Settings.data.googleClientId; },

  // Wie viele Personen die Synchronisation betreffen würde
  pending() {
    return Store.db.persons.filter(p => p.birthdayReminder && hasBirthday(p)).length;
  },

  // Erinnerung gewünscht, aber ohne volles Geburtsdatum nicht machbar
  incomplete() {
    return Store.db.persons.filter(p => p.birthdayReminder && !hasBirthday(p) && !p.death);
  },

  async sync(interactive = false) {
    if (!this.configured()) throw new Error("Keine Google Client-ID hinterlegt");
    await getToken(SCOPE_CALENDAR, interactive);

    let angelegt = 0, aktualisiert = 0, entfernt = 0;
    for (const p of Store.db.persons) {
      if (p.birthdayReminder && hasBirthday(p)) {
        if (p.calendarEventId) {
          try {
            await api(SCOPE_CALENDAR, `${base}/${p.calendarEventId}`, { method: "PATCH", ...json(eventBody(p)) });
            aktualisiert++;
            continue;
          } catch (e) {
            Store.setCalendarEventId(p.id, null); // im Kalender gelöscht → neu anlegen
          }
        }
        const resp = await api(SCOPE_CALENDAR, base, { method: "POST", ...json(eventBody(p)) });
        Store.setCalendarEventId(p.id, (await resp.json()).id);
        angelegt++;
      } else if (p.calendarEventId) {
        try {
          await api(SCOPE_CALENDAR, `${base}/${p.calendarEventId}`, { method: "DELETE" });
        } catch (e) { /* schon weg — auch gut */ }
        Store.setCalendarEventId(p.id, null);
        entfernt++;
      }
    }
    return { angelegt, aktualisiert, entfernt };
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
          `${r.angelegt} neu, ${r.aktualisiert} aktualisiert, ${r.entfernt} entfernt`);
      } catch (e) {
        console.error(e);
        this.setStatus("fehler", e.message);
      }
    }, 3000);
  },
};

Store.onChange((db, dirty) => { if (dirty) Calendar.scheduleSync(); });
