/**
 * Is a prompt written in a language other than English? A quick check with no model: picture and video models follow
 * English prompts best, so a run asks the text helper for an English version only when this says so
 * (src/server/english-prompt.ts). Words in quotes, @handles, <tags>, links and numbers are left out first: they stay as
 * written whatever the language.
 *
 * Two signals:
 * - letters of another script (Cyrillic, Greek, Arabic, Hebrew, Devanagari and other Indic scripts, Thai, CJK, Hangul…)
 *   make up more than 30% of the letters;
 * - in the Latin script, at least two words that are common in another language (or carry its accents: ă, ș, ñ, ç, ß,
 *   ł…) and more of them than common English words. Words that are also English (a, in, on, die, son…) count for
 *   neither side.
 */

/** Common words of other Latin-script languages that English prompts don't use, with and without their accents. */
const OTHER = new Set(
  [
    // Spanish
    "el la los las del que y una unos unas por para muy pero sobre como más mas este esta esto estos sus su lo se mujer hombre chica chico fondo foto fotografía imagen cámara camara blanca blanco negra roja rojo azul hacer quiero",
    // French
    "le les des du une et avec dans sur est sont pas qui au aux ce cette ces sa ses très tres sous femme homme fille blanche noire bleu faire veux",
    // German
    "der das und mit ein eine einen einem ist auf im nicht von vom dem sehr frau mann mädchen hintergrund bild weiß weiss schwarz blau machen",
    // Portuguese
     "os uma com não nao da dos das na em mulher homem fundo sem muito ao branca branco preta preto vermelho azul fazer quero",
    // Italian
    "il gli della delle dello nel nella sul sulla che uno sono uomo ragazza sfondo molto senza bianco nera rosso voglio",
    // Romanian
    "si și cu este sunt trebuie sa să fie nu ca acum pe din cel cea mai foarte fara fără femeie barbat bărbat fata fată fundal alb alba albă albe negru neagra neagră rosu roșu rosie roșie albastru albastra albastră camasa cămașă cămasa rochie sau unei unui vreau fă fa schimba schimbă",
    // Dutch
    "het een voor niet zijn vrouw meisje achtergrond zwart rood blauw maken",
    // Polish, Czech, Slovak, Croatian
    "się nie jest jak oraz kobieta mężczyzna tle biały czarny czerwony niebieski je ve žena muž pozadí bílá černá jsou",
    // Turkish
    "ve bir ile için bu çok kadın erkek arka beyaz siyah kırmızı mavi",
    // Indonesian and Malay
    "dan yang di dengan ini itu untuk wanita pria latar putih hitam merah biru",
    // Tagalog
    "ang ng mga sa babae lalaki puti itim pula",
  ]
    .join(" ")
    .split(" "),
);

/** Common English words of prompts: function words and the words of pictures and edits. */
const ENGLISH = new Set(
  (
    "the of at with and is are to for from by her his their its this that these those it as be was were will should must " +
    "into onto over under behind near next front back while wearing wears holding standing sitting walking looking " +
    "woman man girl boy person people model portrait photo photograph picture image shot close up wide full body " +
    "background light lighting soft hard golden hour night day sunset street city studio scene style cinematic " +
    "white black red blue green yellow pink purple orange grey gray brown silver gold dark bright " +
    "make change turn add remove replace keep same instead like now new old young small large big very " +
    "dress shirt jacket suit hair face eyes hand hands smile smiling camera slow fast moves turns looks walks"
  ).split(" "),
);

/** Accented Latin letters English words don't carry. */
const ACCENTS = /[ăâîșşțţãõñçàèìòùáéíóúêôûäöüßøåæœłńśźżčřšžěůőűğıİ]/i;

/** The parts of a prompt that stay as written in any language: quoted words, @handles, <tags>, links, numbers. */
function plainWords(text: string): string {
  return text
    .replace(/"[^"]*"|“[^”]*”|„[^“”]*[“”]|«[^»]*»|「[^」]*」|『[^』]*』/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]{1,40}>/g, " ")
    .replace(/@[\p{L}\p{N}_.-]+/gu, " ")
    .replace(/\p{N}+/gu, " ");
}

/** Does this prompt read as another language than English (see the top of the file)? */
export function needsEnglish(text: string | undefined | null): boolean {
  if (!text) return false;
  const words = plainWords(text);
  const letters = words.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const other = letters.filter((l) => !/\p{Script=Latin}/u.test(l)).length;
  if (other / letters.length > 0.3) return true;
  let en = 0;
  let fo = 0;
  for (const w of words.toLowerCase().match(/[\p{L}']+/gu) ?? []) {
    if (ENGLISH.has(w)) en++;
    else if (OTHER.has(w) || ACCENTS.test(w)) fo++;
  }
  return fo >= 2 && fo > en;
}
