/**
 * Aturan pengecualian tag (perintah /exclude).
 *
 * Rumus:  yaoi, (male, solo), gore
 *   - koma di luar kurung = ATAU: gambar disembunyikan bila salah satu aturan cocok;
 *   - koma di dalam kurung = DAN: aturan itu baru cocok bila SEMUA tag di dalamnya ada pada gambar.
 *
 * Disimpan sebagai daftar kelompok: [["yaoi"], ["male", "solo"], ["gore"]].
 */
export type ExclusionRules = string[][];

export const MAX_RULES = 50;
export const MAX_TAGS_PER_GROUP = 6;

/** Samakan bentuk tag dengan situs sumber: huruf kecil, spasi menjadi garis bawah. */
function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Ubah teks rumus menjadi aturan. Melempar Error berisi penjelasan bila kurungnya tidak berpasangan. */
export function parseExclusions(text: string): ExclusionRules {
  const rules: ExclusionRules = [];
  let depth = 0;
  let current = "";
  let group: string[] | null = null;

  const pushTag = () => {
    const tag = normalize(current);
    current = "";
    if (!tag) return;
    if (group) group.push(tag);
    else rules.push([tag]);
  };

  for (const char of text) {
    if (char === "(") {
      if (depth > 0) throw new Error("Kurung tidak boleh bersarang. Contoh yang benar: yaoi, (male, solo)");
      pushTag();
      depth = 1;
      group = [];
    } else if (char === ")") {
      if (depth === 0) throw new Error("Ada kurung tutup tanpa kurung buka.");
      pushTag();
      if (group!.length > 0) rules.push([...new Set(group!)]);
      depth = 0;
      group = null;
    } else if (char === "," || char === "\n") {
      pushTag();
    } else {
      current += char;
    }
  }
  if (depth > 0) throw new Error("Ada kurung buka yang belum ditutup.");
  pushTag();

  // Buang aturan kembar
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = [...rule].sort().join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Tulis aturan kembali sebagai rumus, mis. "yaoi, (male, solo)". */
export function formatExclusions(rules: ExclusionRules): string {
  return rules.map((rule) => (rule.length === 1 ? rule[0] : `(${rule.join(", ")})`)).join(", ");
}

/**
 * Buat pemeriksa untuk satu pengguna. Aturan diurai sekali, lalu tiap gambar hanya butuh
 * beberapa pencarian di Set, jadi tidak terasa pada kecepatan hasil.
 */
export function exclusionFilter(formula: string): (tags: string[] | undefined) => boolean {
  let rules: ExclusionRules = [];
  try {
    rules = parseExclusions(formula);
  } catch {}
  if (rules.length === 0) return () => false;

  return (tags) => {
    if (!tags?.length) return false;
    const present = new Set(tags.map((tag) => tag.toLowerCase()));
    return rules.some((rule) => rule.every((tag) => present.has(tag)));
  };
}

// ============================================================================
// KONTEN ANAK DI BAWAH UMUR
// ============================================================================
/**
 * Pemblokiran bawaan bot: berlaku untuk semua pengguna (termasuk owner) dan tidak bisa dimatikan
 * lewat pengaturan apa pun. Dua tingkat:
 *   - SELALU: tag yang menandai seksualisasi anak (loli, shota, ...). Diblokir apa pun ratingnya,
 *     dan ditolak juga sebagai kata kunci pencarian.
 *   - BILA DEWASA: tag anak yang netral (child, young, ...). Gambarnya tetap boleh selama berlabel aman,
 *     tetapi diblokir begitu kirimannya berlabel dewasa.
 * Tag dicocokkan per kata (dipisah "_", "-", spasi), jadi "oppai_loli" ikut kena
 * sedangkan "gothic_lolita" (gaya busana) tidak.
 */
const ALWAYS_WORDS = new Set([
  "loli", "lolis", "lolicon", "shota", "shotas", "shotacon", "toddlercon", "pedo", "pedophile", "pedophilia",
  "jailbait", "underage", "preteen", "prepubescent",
]);
const ADULT_ONLY_WORDS = new Set([
  "child", "children", "kids", "kodomo", "young", "cub", "toddler", "baby", "infant",
  "teen", "teens", "teenage", "teenager",
  "kindergarten", "kindergartener", "elementary", "preschooler", "randoseru",
]);
const ADULT_ONLY_TAGS = new Set([
  "aged_down", "age_regression", "little_girl", "little_boy", "young_girl", "young_boy", "small_girl", "small_boy",
  "elementary_school_student", "elementary_schooler", "grade_schooler", "middle_schooler", "middle_school_student",
  "junior_high_school_student", "kindergarten_uniform", "school_swimsuit_child",
]);

// Tag Jepang (Pixiv) tidak dipisah per kata, jadi dicocokkan sebagai potongan teks.
// Kata serapan yang kebetulan memuat "ロリ" dibuang dulu: カロリー (kalori), ロリータ/ゴスロリ/甘ロリ (gaya busana).
const JP_HARMLESS = /カロリ|ロリータ|ロリィタ|ゴスロリ|甘ロリ|姫ロリ|和ロリ|クラロリ/g;
const JP_ALWAYS = /ロリ|ショタ|ペド|ろり|しょた|幼女|幼児|幼稚園|園児|女児|男児|小学生|js\d|メスガキ|つるぺた|ランドセル/;
const JP_ADULT_ONLY = /中学生|jc\d|子供|子ども|こども|未成年/;

function minorLevel(rawTag: string): "always" | "adult" | null {
  const tag = normalize(rawTag);
  if (!tag) return null;

  const japanese = tag.replace(JP_HARMLESS, "");
  if (JP_ALWAYS.test(japanese)) return "always";

  const words = tag.split(/[_\-\s:()]+/).filter(Boolean);
  if (words.some((w) => ALWAYS_WORDS.has(w))) return "always";
  if (ADULT_ONLY_TAGS.has(tag) || words.some((w) => ADULT_ONLY_WORDS.has(w)) || JP_ADULT_ONLY.test(japanese)) return "adult";
  return null;
}

/**
 * Apakah item bertag ini harus disembunyikan karena memuat anak di bawah umur.
 * `isAdult` = kiriman berlabel dewasa (rating questionable/explicit, atau situsnya seluruhnya dewasa).
 */
export function isMinorContent(tags: string[] | undefined, isAdult: boolean): boolean {
  if (!tags?.length) return false;
  return tags.some((tag) => {
    const level = minorLevel(tag);
    return level === "always" || (level === "adult" && isAdult);
  });
}

/**
 * Apakah kata kunci pencarian meminta konten yang selalu diblokir.
 * Tag berawalan "-" berarti pengecualian (menyingkirkan), jadi tidak dihitung.
 */
export function isMinorQuery(query: string): boolean {
  return query
    .split(/[\s,]+/)
    .filter((word) => word && !word.startsWith("-"))
    .some((word) => minorLevel(word.replace(/^[~+]/, "")) === "always");
}
