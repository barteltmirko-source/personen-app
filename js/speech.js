// speech.js — Sprachausgabe über die eingebaute Browser-Stimme
"use strict";

import { Settings } from "./store.js";

let germanVoice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  germanVoice =
    voices.find(v => v.lang === "de-DE" && v.localService) ||
    voices.find(v => v.lang === "de-DE") ||
    voices.find(v => v.lang.startsWith("de")) ||
    null;
}

if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export function speak(text) {
  if (!Settings.data.ttsEnabled) return;
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "de-DE";
  if (germanVoice) u.voice = germanVoice;
  u.rate = 1.0;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
