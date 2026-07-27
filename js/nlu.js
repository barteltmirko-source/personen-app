// nlu.js — Sprachverstehen: erst Regelmuster (kostenlos), dann Claude-API (Hybrid)
"use strict";

import { Store, Settings, ageText, fullName, deceasedSentence, contextLabel } from "./store.js";

// ---------- Öffentliche Schnittstelle ----------

// Gesprächsgedächtnis der aktuellen Sitzung (überlebt keinen Neustart)
const history = [];
const HISTORY_LIMIT = 10;

function remember(role, text) {
  history.push({ role, text });
  while (history.length > HISTORY_LIMIT) history.shift();
}

// Verarbeitet eine Nutzereingabe und liefert { reply, changed }.
export async function handleInput(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { reply: "Ich habe nichts gehört.", changed: false };

  let result = tryRules(trimmed);
  if (!result) {
    if (!Settings.data.anthropicKey) {
      result = {
        reply: "Das habe ich mit meinen einfachen Mustern nicht verstanden. " +
          "Für frei formulierte Eingaben hinterlege bitte in den Einstellungen einen Anthropic-API-Schlüssel.",
        changed: false,
      };
    } else {
      result = await askClaude(trimmed);
    }
  }
  remember("user", trimmed);
  remember("assistant", result.reply);
  return result;
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
  if ((m = t.match(/^woher (?:kenne ich|kennst du|kennt man|kennen wir) (.+)$/)))
    return answerContext(m[1]);
  if ((m = t.match(/^wer (?:ist|sind|gehört)(?: alles)? (?:in|zu|zur|zum) (?:der |die |kategorie |gruppe )?(.+)$/)))
    return answerTagMembers(m[1]); // liefert null, wenn kein Tag passt → Claude
  if ((m = t.match(/^wer ist (?:der |die |das )?([a-zäöüß]+(?:in)?) von (.+)$/)))
    return answerRelation(m[1], m[2]); // liefert null, wenn nichts gefunden → Claude
  if ((m = t.match(/^wer ist (.+)$/)))
    return answerWho(m[1]);
  if ((m = t.match(/^(?:wer sind )?(?:die )?eltern von (.+)$/)))
    return answerParents(m[1]);
  if ((m = t.match(/^(?:wo|bei welcher firma|für wen) arbeitet (.+)$/)))
    return answerWork(m[1]);
  if ((m = t.match(/^als was arbeitet (.+)$/)))
    return answerWork(m[1]);

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
  if (r.person.death) return { reply: deceasedSentence(r.person), changed: false };
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

function answerWork(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const p = r.person;
  if (!p.company && !p.position)
    return { reply: `Zur Arbeit von ${fullName(p)} ist nichts eingetragen.`, changed: false };
  let reply = fullName(p) + " arbeitet";
  if (p.position) reply += ` als ${p.position}`;
  if (p.company) reply += ` bei ${p.company}`;
  return { reply: reply + ".", changed: false };
}

// „Wer ist der Opa von Lena?" — prüft freie Beziehungen + abgeleitete Großeltern/Enkel.
// Liefert null (→ Claude), wenn das Etikett unbekannt ist oder nichts gefunden wird.
function answerRelation(labelRaw, name) {
  const r = resolve(name);
  if (r.error) return null;
  const p = r.person;
  const label = labelRaw.toLowerCase();

  const grandparentWords = ["oma", "opa", "großmutter", "grossmutter", "großvater", "grossvater"];
  const grandchildWords = ["enkel", "enkelin", "enkelkind"];

  const found = [];
  const { incoming } = Store.relationsFor(p.id);
  for (const { rel, other } of incoming) {
    const rl = rel.label.toLowerCase();
    if (rl === label || rl === label + "in" || rl + "in" === label) found.push(other);
  }
  if (grandparentWords.includes(label))
    for (const gp of Store.grandparentsOf(p.id))
      if (!found.some(f => f.id === gp.id)) found.push(gp);
  if (grandchildWords.includes(label))
    for (const gc of Store.grandchildrenOf(p.id))
      if (!found.some(f => f.id === gc.id)) found.push(gc);

  if (!found.length) return null; // Claude darf es mit mehr Kontext versuchen
  const list = found.map(f => `${fullName(f)} (${ageText(f)})`).join(" und ");
  return { reply: `${capitalize(labelRaw)} von ${fullName(p)}: ${list}.`, changed: false };
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// „Wer ist alles in Familie 1. Grad?"
function answerTagMembers(tagNameRaw) {
  const tag = Store.findTagByName(tagNameRaw);
  if (!tag) return null; // vielleicht meint der Nutzer etwas anderes → Claude
  const members = Store.personsWithTag(tag.id);
  if (members.length === 0)
    return { reply: `In der Kategorie „${tag.name}" ist niemand.`, changed: false };
  const list = members.map(p => `${fullName(p)} (${ageText(p)})`).join(", ");
  return { reply: `In „${tag.name}": ${list}.`, changed: false };
}

// „Woher kenne ich Anna?" — nennt nur privat/geschäftlich, nie die Kategorie selbst.
function answerContext(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const label = contextLabel(r.person);
  if (!label)
    return { reply: `Woher du ${fullName(r.person)} kennst, ist nicht hinterlegt.`, changed: false };
  const wording = label === "privat und geschäftlich"
    ? "sowohl privat als auch geschäftlich"
    : `aus dem ${label === "privat" ? "privaten" : "geschäftlichen"} Umfeld`;
  return { reply: `${fullName(r.person)} kennst du ${wording}.`, changed: false };
}

function answerWho(name) {
  const r = resolve(name);
  if (r.error) return { reply: r.error, changed: false };
  const p = r.person;
  const parts = [`${fullName(p)}, ${ageText(p)}`];
  if (p.position || p.company)
    parts.push(["arbeitet", p.position ? "als " + p.position : "", p.company ? "bei " + p.company : ""].filter(Boolean).join(" "));
  const partner = Store.partnerOf(p.id);
  if (partner) parts.push(`Partner/in: ${fullName(partner)}`);
  const kids = Store.childrenOf(p.id);
  if (kids.length) parts.push(`Kinder: ${kids.map(k => `${k.firstName} (${ageText(k)})`).join(", ")}`);
  const parents = Store.parentsOf(p.id);
  if (parents.length) parts.push(`Kind von ${parents.map(fullName).join(" und ")}`);
  const { outgoing, incoming } = Store.relationsFor(p.id);
  for (const { rel, other } of outgoing) parts.push(`${rel.label} von ${fullName(other)}`);
  for (const { rel, other } of incoming) parts.push(`${fullName(other)} ist ${rel.label}`);
  // Kategorien bleiben bewusst außen vor — siehe answerContext für privat/geschäftlich.
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
- {"op":"create_person","firstName":"...","lastName":"...","birthDate":"YYYY-MM-DD"|null,"birthYear":2010|null,"ageYears":42|null,"company":"..."|null,"position":"..."|null}
  (nutze birthDate wenn volles Datum bekannt, sonst birthYear, sonst ageYears; lastName darf leer sein)
- {"op":"update_person","person":"Name","firstName":"...","lastName":"...","birthDate":...,"birthYear":...,"ageYears":...,"company":"...","position":"...","deceased":true|false,"deathDate":"YYYY-MM-DD"|null,"deathYear":2023|null}
  (nur die Felder angeben, die geändert werden sollen; company = Firma, position = Berufsbezeichnung.
   Wenn jemand gestorben ist: deceased:true setzen, plus deathDate oder deathYear falls bekannt. deceased:false macht eine irrtümliche Eintragung rückgängig.)
- {"op":"set_partner","a":"Name","b":"Name"}
- {"op":"add_parent_child","parent":"Name","child":"Name"}
- {"op":"add_relation","from":"Name","label":"Opa","to":"Name"}
  (bedeutet: from ist <label> von to, z.B. "Peter ist Opa von Lena". Für beliebige Beziehungen: Oma, Opa, Onkel, Tante, Cousin, Nachbar, Chef, Freund, ...)
- {"op":"add_note","person":"Name","text":"..."}
- {"op":"add_tag","person":"Name","tag":"Freunde"}
  (ordnet die Person einer Kategorie zu; existiert die Kategorie nicht, wird sie angelegt. Nutze bevorzugt vorhandene Kategorien aus der "verfuegbareKategorien"-Liste.)
- {"op":"remove_tag","person":"Name","tag":"Freunde"}
- {"op":"delete_person","person":"Name"}  (nur wenn der Nutzer das ausdrücklich verlangt)

Regeln:
- "Name" ist immer ein Name, der die Person eindeutig identifiziert (bevorzugt "Vorname Nachname"). Bei neuen Personen exakt der Name aus create_person.
- Wenn der Nutzer eine Familie beschreibt (z.B. "Max Mustermann, seine Frau Anna ist 40, Kinder Lena 8 und Tom 5"): lege alle Personen an, verknüpfe Partner, und trage BEIDE Elternteile für jedes Kind ein. Kinder erben den Nachnamen der Eltern, wenn nichts anderes gesagt wird.
- Prüfe vorher in der Datenbank, ob eine Person schon existiert — dann kein create_person, sondern direkt verknüpfen/aktualisieren.
- Bei reinen Fragen: beantworte sie aus der Datenbank in "reply", mutations bleibt []. Nutze auch Ableitungen: Großeltern = Eltern der Eltern, Geschwister = gleiche Eltern, Onkel/Tante über die "beziehungen"-Liste.
- Bei Unklarheiten oder wenn eine Person nicht gefunden wird: erkläre das kurz in "reply", mutations bleibt [].
- Alter: die Datenbank speichert Geburtsjahre/-daten. "ageYears" wird von der App automatisch in ein geschätztes Geburtsjahr umgerechnet.
- Kategorien sind eine rein interne Ordnungshilfe. Nenne in "reply" NIEMALS einen Kategorienamen und behandle die Kategorie einer Person nie als Auskunft über sie — auch nicht auf Nachfrage, bei Zusammenfassungen ("Wer ist X?") oder Aufzählungen. Deshalb steht bei jeder Person nur das Feld "kontext" (privat / geschäftlich / privat und geschäftlich / null).
- Fragt der Nutzer, woher er jemanden kennt, nenne ausschließlich diesen groben "kontext" (z. B. "Anna kennst du aus dem privaten Umfeld."). Ist "kontext" null, sage, dass dazu nichts hinterlegt ist.
- Zuordnen bleibt erlaubt: Nennt der Nutzer beim Anlegen eine Kategorie, setze sie per add_tag (das entfernt "Unsortiert" automatisch); bestätige das ohne den Kategorienamen zu wiederholen. Jede Person hat mindestens eine Kategorie; ohne Zuordnung automatisch "Unsortiert".
- Der bisherige Gesprächsverlauf wird mitgeschickt: Löse Bezüge wie "er", "sie", "seine Frau", "dort" anhand der letzten Nachrichten auf.
- Antworte immer knapp und freundlich, wie ein Assistent, der vorgelesen wird. Heutiges Datum: {{TODAY}}.`;

async function askClaude(text) {
  const dbForClaude = {
    personen: Store.db.persons.map(p => ({
      name: fullName(p),
      geburt: p.birth,
      alter: ageText(p),
      verstorben: p.death ? (p.death.date || p.death.year || true) : false,
      firma: p.company || null,
      position: p.position || null,
      partner: Store.partnerOf(p.id) ? fullName(Store.partnerOf(p.id)) : null,
      eltern: Store.parentsOf(p.id).map(fullName),
      kinder: Store.childrenOf(p.id).map(fullName),
      kontext: contextLabel(p), // grobe Einordnung statt der Kategorienamen
      notizen: p.notes.map(n => ({ datum: n.date.slice(0, 10), text: n.text })),
    })),
    // Nur als Auswahlliste für add_tag/remove_tag — nicht als Info über Personen.
    verfuegbareKategorien: Store.allTags().map(t => t.name),
    beziehungen: Store.db.relations.map(r => {
      const from = Store.get(r.fromId), to = Store.get(r.toId);
      return from && to ? `${fullName(from)} ist ${r.label} von ${fullName(to)}` : null;
    }).filter(Boolean),
  };

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
          content:
            (history.length
              ? "Bisheriger Gesprächsverlauf (für Bezüge wie \"er\"/\"sie\"):\n" +
                history.map(h => (h.role === "user" ? "Nutzer: " : "Assistent: ") + h.text).join("\n") + "\n\n"
              : "") +
            `Datenbank:\n${JSON.stringify(dbForClaude, null, 1)}\n\nEingabe des Nutzers:\n${text}`,
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
        case "add_relation": {
          const from = mustFind(mut.from), to = mustFind(mut.to);
          Store.addRelation(from.id, to.id, mut.label);
          changed = true;
          break;
        }
        case "add_note": {
          const p = mustFind(mut.person);
          Store.addNote(p.id, mut.text);
          changed = true;
          break;
        }
        case "add_tag": {
          const p = mustFind(mut.person);
          const tag = Store.findTagByName(mut.tag) || Store.createTag(mut.tag);
          if (tag) { Store.addTagToPerson(p.id, tag.id); changed = true; }
          break;
        }
        case "remove_tag": {
          const p = mustFind(mut.person);
          const tag = Store.findTagByName(mut.tag);
          if (tag) { Store.removeTagFromPerson(p.id, tag.id); changed = true; }
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
