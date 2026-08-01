// ics.js — genügsamer Parser für Kalenderdateien (.ics), nur so viel wie der
// Geburtstags-Import braucht: Titel und Startdatum je Termin.
//
// Bewusst kein vollständiger RFC-5545-Parser. Zeitzonen, Ausnahmen und
// Wiederholungsregeln interessieren hier nicht — ein Geburtstag ist Tag und
// Monat, alles Weitere ist Beiwerk.
"use strict";

// Lange Zeilen werden in .ics umgebrochen und mit einem führenden Leerzeichen
// oder Tabulator fortgesetzt. Das muss zuerst rückgängig gemacht werden, sonst
// zerreißt es lange Namen.
function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

// \, \; \n und \\ sind in .ics maskiert
function unescape(s) {
  return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

// Der Titel wird unverändert übernommen: erstes Wort Vorname, alles Weitere
// Nachname. Bewusst ohne Filterung von Füllwörtern wie „Geburtstag“ — geraten
// wird hier nichts, was am Ende falsch steht, korrigierst du auf der
// Personenseite.
export function nameFromSummary(summary) {
  const parts = String(summary || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

// Liefert [{ summary, year, month, day }] — je Termin einer.
export function parseIcs(text) {
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) { cur = {}; continue; }
    if (line.startsWith("END:VEVENT")) {
      // Termine ohne Titel oder Datum sind für uns wertlos. RECURRENCE-ID
      // kennzeichnet die Abwandlung eines einzelnen Termins einer Serie — die
      // Serie selbst steht schon in der Datei, sonst gäbe es die Person doppelt.
      if (cur && cur.summary && cur.day && !cur.recurrenceId) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;

    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const name = line.slice(0, sep).split(";")[0].toUpperCase();
    const value = line.slice(sep + 1);

    if (name === "SUMMARY") cur.summary = unescape(value);
    else if (name === "RECURRENCE-ID") cur.recurrenceId = true;
    else if (name === "DTSTART") {
      const m = value.match(/(\d{4})(\d{2})(\d{2})/);
      if (m) {
        cur.year = Number(m[1]);
        cur.month = Number(m[2]);
        cur.day = Number(m[3]);
      }
    }
  }
  return events;
}
