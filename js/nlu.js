// nlu.js — Sprachverstehen: erst Regelmuster (kostenlos), dann Claude-API (Hybrid)
"use strict";

import { Store, Settings, ageText, fullName } from "./store.js";

// ---------- Öffentliche Schnittstelle ----------

// Verarbeitet eine Nutzereingabe und liefert { reply, changed }.
export async function handleInput(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { reply: "Ich habe nichts gehört.", changed: false };

  const ruleResult = tryRules(trimmed);
  if (ruleResult) return ruleResult;

  if (!Settings.data.anthropicKey) {
    return {
      reply: "Das habe ich mit meinen einfachen Mustern nicht verstanden. " +
        "Für frei formulierte Eingaben hinterlege bitte in den Einstellungen einen Anthropic-API-Schlüssel.",
      changed: false,
    };
  }
  return await askClaude(trimmed);
}

// ---------- Regelbasierte Muster ----------

function tryRules(text) {
  const t = text.toLowerCase().replace(/[?!.]+$/g, "").trim();

  let m;
  if ((m = t.match(/^(?:welche |was für )?kinder (?:hat|von) (.+)$/)))
    return answerChildren(m[1]);
  if ((m = t.match(/^wie alt ist (.+)$/)))
    return answerAge(m[1]);
  if ((m = t.match(/^(?:zeige? |sag(?:e)? |lies |gib )?(?:mir )?(?:die |alle )?notizen (?:zu|von|über|zur person|zu person) (.+)$/)))
    return answerNotes(m[1]);
  if ((m = t.match(/^wer ist (?:der |die )?partner(?:in)? von (.+)$/)))
    return answerPartner(m[1]);
  if ((m = t.match(/^wer ist (.+)$/)))
    return answerWho(m[1]);
  if ((m = t.match(/^(?:wer sind )?(?:die )?eltern von (.+)$/)))
    return answerParents(m[1]);

  return null; // kein Muster → Claude
}

function resolve(nameRaw) {
  const name = nameRaw.trim();
  const matches = Store.findByName(name);
  if (matches.length === 0) return { error: `Ich habe niemanden mit dem Namen „${name}" gefunden.` };
  if (matches.length > 1) {
    const first = matches[0], second = matches[1];
    // Nur nachfragen, wenn es echt mehrdeutig ist (gleicher Trefferwert unklar → einfache Heuristik: gleicher Vorname)
    if (fullName(first).toLowerCase() !== name.toLowerCase() &&
        first.firstName.toLowerCase() === second.firstName.toLowerCase()) {
      return { error: `Meinst du ${fullName(first)} oder ${fullName(second)}? Bitte nenne den vollen Namen.` };
    }
  }
  return { person: matches[0] };
}

function answerChildren(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const kids = Store.childrenOf(r.person.id);
  if (kids.length === 0)
    return { reply: `Zu ${fullName(r.person)} sind keine Kinder eingetragen.`, changed: false };
  const list = kids.map(k => `${k.firstName} (${ageText(k)})`).join(", ");
  return { reply: `${fullName(r.person)} hat ${kids.length === 1 ? "ein Kind" : kids.length + " Kinder"}: ${list}.`, changed: false };
}

function answerAge(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const a = ageText(r.person);
  return {
    reply: a === "Alter unbekannt"
      ? `Zum Alter von ${fullName(r.person)} ist nichts eingetragen.`
      : `${fullName(r.person)} ist ${a.replace("Jahre", "Jahre alt")}.`,
    changed: false,
  };
}

function answerNotes(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const notes = r.person.notes;
  if (notes.length === 0)
    return { reply: `Zu ${fullName(r.person)} gibt es noch keine Notizen.`, changed: false };
  const list = notes.map(n => {
    const d = new Date(n.date);
    return `${d.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" })}: ${n.text}`;
  }).join(" — ");
  return { reply: `Notizen zu ${fullName(r.person)}: ${list}`, changed: false };
}

function answerPartner(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const partner = Store.partnerOf(r.person.id);
  if (!partner) return { reply: `Zu ${fullName(r.person)} ist kein Partner eingetragen.`, changed: false };
  return { reply: `${fullName(partner)} (${ageText(partner)}) ist Partner/in von ${fullName(r.person)}.`, changed: false };
}

function answerParents(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const parents = Store.parentsOf(r.person.id);
  if (parents.length === 0) return { reply: `Zu ${fullName(r.person)} sind keine Eltern eingetragen.`, changed: false };
  return { reply: `Eltern von ${fullName(r.person)}: ${parents.map(fullName).join(" und ")}.`, changed: false };
}

function answerWho(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const p = r.person;
  const parts = [`${fullName(p)}, ${ageText(p)}`];
  const partner = Store.partnerOf(p.id);
  if (partner) parts.push(`Partner/in: ${fullName(partner)}`);
  const kids = Store.childrenOf(p.id);
  if (kids.length) parts.push(`Kinder: ${kids.map(k => `${k.firstName} (${ageText(k)})`).join(", ")}`);
  const parents = Store.parentsOf(p.id);
  if (parents.length) parts.push(`Kind von ${parents.map(fullName).join(" und ")}`);
  if (p.notes.length) parts.push(`${p.notes.length} Notiz${p.notes.length > 1 ? "en" : ""} vorhanden`);
  return { reply: parts.join(". ") + ".", changed: false };
}

// ---------- Claude-Fallback ----------

const SYSTEM_PROMPT = `Du bist die Sprachsteuerung einer privaten Personen-Datenbank-App ("Personen-Gedächtnis").
Der Nutzer spricht Deutsch. Du bekommst die komplette Datenbank als JSON und die Eingabe des Nutzers.

Deine Aufgabe: Verstehe die Eingabe und antworte AUSSCHLIESSLICH mit einem JSON-Objekt (kein Markdown, kein Text davor/danach) nach diesem Schema:

{
  "reply": "Kurze, natürliche deutsche Antwort, die vorgelesen wird.",
  "mutations": [ ... ]  // leer lassen, wenn nur eine Frage beantwortet wird
}

Erlaubte Mutationen (in dieser Reihenfolge ausgeführt):
- {"op":"create_person","firstName":"...","lastName":"...","birthDate":"YYYY-MM-DD"|null,"birthYear":2010|null,"ageYears":42|null}
  (nutze birthDate wenn volles Datum bekannt, sonst birthYear, sonst ageYears; lastName darf leer sein)
- {"op":"update_person","person":"Name","firstName":"...","lastName":"...","birthDate":...,"birthYear":...,"ageYears":...}
  (nur die Felder angeben, die geändert werden sollen)
- {"op":"set_partner","a":"Name","b":"Name"}
- {"op":"add_parent_child","parent":"Name","child":"Name"}
- {"op":"add_note","person":"Name","text":"..."}
- {"op":"delete_person","person":"Name"}  (nur wenn der Nutzer das ausdrücklich verlangt)

Regeln:
- "Name" ist immer ein Name, der die Person eindeutig identifiziert (bevorzugt "Vorname Nachname"). Bei neuen Personen exakt der Name aus create_person.
- Wenn der Nutzer eine Familie beschreibt (z.B. "Max Mustermann, seine Frau Anna ist 40, Kinder Lena 8 und Tom 5"): lege alle Personen an, verknüpfe Partner, und trage BEIDE Elternteile für jedes Kind ein. Kinder erben den Nachnamen der Eltern, wenn nichts anderes gesagt wird.
- Prüfe vorher in der Datenbank, ob eine Person schon existiert — dann kein create_person, sondern direkt verknüpfen/aktualisieren.
- Bei reinen Fragen: beantworte sie aus der Datenbank in "reply", mutations bleibt [].
- Bei Unklarheiten oder wenn eine Person nicht gefunden wird: erkläre das kurz in "reply", mutations bleibt [].
- Alter: die Datenbank speichert Geburtsjahre/-daten. "ageYears" wird von der App automatisch in ein geschätztes Geburtsjahr umgerechnet.
- Antworte immer knapp und freundlich, wie ein Assistent, der vorgelesen wird. Heutiges Datum: {{TODAY}}.`;

async function askClaude(text) {
  const dbForClaude = Store.db.persons.map(p => ({
    name: fullName(p),
    geburt: p.birth,
    alter: ageText(p),
    partner: Store.partnerOf(p.id) ? fullName(Store.partnerOf(p.id)) : null,
    eltern: Store.parentsOf(p.id).map(fullName),
    kinder: Store.childrenOf(p.id).map(fullName),
    notizen: p.notes.map(n => ({ datum: n.date.slice(0, 10), text: n.text })),
  }));

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Settings.data.anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system: SYSTEM_PROMPT.replace("{{TODAY}}", new Date().toLocaleDateString("de-DE")),
        messages: [{
          role: "user",
          content: `Datenbank:\n${JSON.stringify(dbForClaude, null, 1)}\n\nEingabe des Nutzers:\n${text}`,
        }],
      }),
    });
  } catch (e) {
    return { reply: "Ich konnte die KI nicht erreichen. Bist du mit dem Internet verbunden?", changed: false };
  }

  if (!resp.ok) {
    if (resp.status === 401) return { reply: "Der Anthropic-API-Schlüssel wurde abgelehnt. Bitte prüfe ihn in den Einstellungen.", changed: false };
    return { reply: `Die KI hat einen Fehler gemeldet (Code ${resp.status}). Versuche es bitte noch einmal.`, changed: false };
  }

  const data = await resp.json();
  const raw = (data.content?.[0]?.text || "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json?\s*/i, "").replace(/```\s*$/, ""));
  } catch (e) {
    return { reply: raw || "Das habe ich leider nicht verstanden.", changed: false };
  }

  const changed = applyMutations(parsed.mutations || []);
  return { reply: parsed.reply || "Erledigt.", changed };
}

function applyMutations(mutations) {
  let changed = false;
  for (const mut of mutations) {
    try {
      switch (mut.op) {
        case "create_person": {
          Store.createPerson(mut);
          changed = true;
          break;
        }
        case "update_person": {
          const p = mustFind(mut.person);
          Store.updatePerson(p.id, mut);
          changed = true;
          break;
        }
        case "set_partner": {
          const a = mustFind(mut.a), b = mustFind(mut.b);
          Store.setPartner(a.id, b.id);
          changed = true;
          break;
        }
        case "add_parent_child": {
          const parent = mustFind(mut.parent), child = mustFind(mut.child);
          Store.addParentChild(parent.id, child.id);
          changed = true;
          break;
        }
        case "add_note": {
          const p = mustFind(mut.person);
          Store.addNote(p.id, mut.text);
          changed = true;
          break;
        }
        case "delete_person": {
          const p = mustFind(mut.person);
          Store.deletePerson(p.id);
          changed = true;
          break;
        }
      }
    } catch (e) {
      console.warn("Mutation übersprungen:", mut, e.message);
    }
  }
  return changed;
}

function mustFind(name) {
  const matches = Store.findByName(name);
  if (!matches.length) throw new Error(`Person nicht gefunden: ${name}`);
  return matches[0];
}
