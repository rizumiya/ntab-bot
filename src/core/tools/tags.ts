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
