/**
 * Devanagari → romanised Hinglish: the spelling people actually use in
 * captions and chats ("nahi", "hai", "karna"), not academic ISO-15919.
 * Frequent words come from a lookup table; everything else goes through
 * letter rules plus Hindi schwa deletion ("करना" → "karna", not "karanaa").
 * English words that Whisper wrote in Devanagari come out phonetic
 * ("क्रिएटर्स" → "kriyetars") — imperfect, but one readable script.
 */

const COMMON_WORDS: Record<string, string> = {
  है: "hai", हैं: "hain", में: "mein", मैं: "main", नहीं: "nahi", नही: "nahi", यह: "yeh", ये: "ye",
  वह: "woh", वो: "woh", क्या: "kya", क्यों: "kyun", क्योंकि: "kyunki", कि: "ki", की: "ki", के: "ke",
  का: "ka", को: "ko", से: "se", पर: "par", तो: "toh", और: "aur", भी: "bhi", ही: "hi", जो: "jo",
  हम: "hum", तुम: "tum", आप: "aap", हूँ: "hoon", हूं: "hoon", हो: "ho", था: "tha", थी: "thi",
  थे: "the", एक: "ek", अब: "ab", जब: "jab", तब: "tab", सब: "sab", कुछ: "kuch", बहुत: "bahut",
  लेकिन: "lekin", मतलब: "matlab", अपना: "apna", अपनी: "apni", अपने: "apne", उन्होंने: "unhone",
  इन्होंने: "inhone", उनके: "unke", उनकी: "unki", उनका: "unka", इसके: "iske", इसका: "iska",
  इसकी: "iski", उसके: "uske", यहाँ: "yahan", वहाँ: "wahan", रहा: "raha", रही: "rahi", रहे: "rahe",
  कर: "kar", करना: "karna", करते: "karte", जी: "ji", हाँ: "haan", हां: "haan", ना: "na", न: "na",
  मुझे: "mujhe", तुम्हें: "tumhe", साथ: "saath", बात: "baat", लिए: "liye", बाद: "baad",
  पहले: "pehle", ज़्यादा: "zyada", ज्यादा: "zyada", जादा: "zyada", थोड़ा: "thoda", अच्छा: "accha",
  ठीक: "theek", वाला: "wala", वाली: "wali", वाले: "wale", यार: "yaar", सच: "sach",
};

const CONSONANTS: Record<string, string> = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "n", च: "ch", छ: "chh", ज: "j", झ: "jh", ञ: "n",
  ट: "t", ठ: "th", ड: "d", ढ: "dh", ण: "n", त: "t", थ: "th", द: "d", ध: "dh", न: "n",
  प: "p", फ: "ph", ब: "b", भ: "bh", म: "m", य: "y", र: "r", ल: "l", ळ: "l", व: "v",
  श: "sh", ष: "sh", स: "s", ह: "h",
};
// Consonant + nukta (U+093C) after NFD normalisation.
const NUKTA_CONSONANTS: Record<string, string> = {
  क: "q", ख: "kh", ग: "g", ज: "z", ड: "d", ढ: "dh", फ: "f", य: "y",
};
const VOWELS: Record<string, string> = {
  अ: "a", आ: "aa", इ: "i", ई: "ee", उ: "u", ऊ: "oo", ऋ: "ri", ए: "e", ऐ: "ai", ओ: "o", औ: "au",
  ऑ: "o", ऍ: "e",
};
// Matras. Long ā/ī/ū are only written long ("aa", "ee", "oo") inside short
// words (baat, beech, poora); elsewhere Hinglish spelling uses the short form
// (kumar, tarika, rahi).
const MATRAS: Record<string, { long?: string; short: string }> = {
  "ा": { long: "aa", short: "a" }, "ी": { long: "ee", short: "i" }, "ू": { long: "oo", short: "u" },
  "ि": { short: "i" }, "ु": { short: "u" }, "ृ": { short: "ri" }, "े": { short: "e" }, "ै": { short: "ai" },
  "ो": { short: "o" }, "ौ": { short: "au" }, "ॉ": { short: "o" }, "ॅ": { short: "e" },
};
const VIRAMA = "्";
const NUKTA = "़";
const NASALS = new Set(["ं", "ँ"]); // anusvara, chandrabindu
const VISARGA = "ः";

type Unit =
  | { kind: "C"; sound: string; matra: string | null; virama: boolean }
  | { kind: "V"; sound: string }
  | { kind: "N" } // nasal sign
  | { kind: "X"; text: string };

function parse(word: string): Unit[] {
  const chars = [...word.normalize("NFD")];
  const units: Unit[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CONSONANTS[ch]) {
      let sound = CONSONANTS[ch];
      if (chars[i + 1] === NUKTA) {
        sound = NUKTA_CONSONANTS[ch] ?? sound;
        i++;
      }
      // ज्ञ is pronounced "gy" ("gyaan").
      if (ch === "ज" && chars[i + 1] === VIRAMA && chars[i + 2] === "ञ") {
        sound = "gy";
        i += 2;
      }
      units.push({ kind: "C", sound, matra: null, virama: false });
    } else if (MATRAS[ch] !== undefined || ch === VIRAMA) {
      const last = units[units.length - 1];
      if (last?.kind === "C") {
        if (ch === VIRAMA) last.virama = true;
        else last.matra = ch;
      }
    } else if (VOWELS[ch]) {
      units.push({ kind: "V", sound: VOWELS[ch] });
    } else if (NASALS.has(ch)) {
      units.push({ kind: "N" });
    } else if (ch === VISARGA) {
      units.push({ kind: "X", text: "h" });
    } else if (ch >= "०" && ch <= "९") {
      units.push({ kind: "X", text: String(ch.charCodeAt(0) - 0x0966) });
    }
    // Anything else in the block (rare signs) is dropped.
  }
  return units;
}

function hasVowel(u: Unit | undefined, dropped: Set<number>, idx: number): boolean {
  if (!u) return false;
  if (u.kind === "V") return true;
  return u.kind === "C" && !u.virama && !dropped.has(idx);
}

function transliterateWord(word: string): string {
  const units = parse(word);
  const letterIdx = units.map((u, i) => (u.kind === "C" || u.kind === "V" ? i : -1)).filter((i) => i >= 0);
  const dropped = new Set<number>(); // consonants whose inherent "a" is silent

  // Schwa deletion: a word-final consonant loses its "a" (कर → kar) unless it
  // is the only letter; a medial one does too between vowels (करना → karna).
  const lastLetter = letterIdx[letterIdx.length - 1];
  if (letterIdx.length > 1) {
    const u = units[lastLetter];
    if (u.kind === "C" && u.matra === null && !u.virama) dropped.add(lastLetter);
  }
  for (let k = letterIdx.length - 2; k >= 1; k--) {
    const i = letterIdx[k];
    const u = units[i];
    if (u.kind !== "C" || u.matra !== null || u.virama) continue;
    const prev = letterIdx[k - 1];
    const next = letterIdx[k + 1];
    if (hasVowel(units[prev], dropped, prev) && units[next].kind === "C" && hasVowel(units[next], dropped, next)) {
      dropped.add(i);
    }
  }

  const shortWord = letterIdx.length <= 2;
  let out = "";
  units.forEach((u, i) => {
    if (u.kind === "C") {
      out += u.sound;
      if (u.virama || dropped.has(i)) return;
      if (!u.matra) {
        out += "a";
        return;
      }
      const m = MATRAS[u.matra];
      out += m.long && shortWord && i < lastLetter ? m.long : m.short;
    } else if (u.kind === "V") {
      out += u.sound;
    } else if (u.kind === "N") {
      const next = units[i + 1];
      out += next?.kind === "C" && /^(p|b|bh|m)$/.test(next.sound) ? "m" : "n";
    } else {
      out += u.text;
    }
  });
  return out;
}

// Keys normalised so precomposed and decomposed nukta letters both match.
const COMMON = new Map(Object.entries(COMMON_WORDS).map(([k, v]) => [k.normalize("NFC"), v]));

const DEVANAGARI_RUN = /[ऀ-ॣ०-ॿ]+/g;

export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/** Romanises every Devanagari run in `text`, leaving Latin text, spacing and punctuation as-is. */
export function devanagariToHinglish(text: string): string {
  return text
    .replace(/[।॥]/g, ".") // danda
    .replace(DEVANAGARI_RUN, (run) => COMMON.get(run.normalize("NFC")) ?? transliterateWord(run));
}
