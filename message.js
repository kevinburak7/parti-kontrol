// @ts-check
/**
 * Parti kontrolu telefon formu - mesaj ureticisi ve link cozucusu
 * (SPEC-inventory.md "Parti kontrolünü telefondan doldurma" KT2, KT5; ADR 0054).
 *
 * npm bagimliligi yok, tarayicida ES modulu olarak calisir. Program tarafi:
 * src/modules/inventory/lot-checklist-message.ts. Kod (sağlama) hesabi orada da ayni yazilidir;
 * ikisi src/modules/inventory/lot-checklist-message.roundtrip.test.ts ile baglidir.
 */

/** @typedef {"NOT_CHECKED" | "OK" | "NOT_OK" | "NOT_APPLICABLE"} CheckStatus */

/**
 * @typedef {object} PhoneCheck
 * @property {string} lotNumber
 * @property {string | null} productHint
 * @property {string | null} [productCode] listeden secilen urunun kodu (UL3)
 * @property {string} checkedOn "YYYY-AA-GG"
 * @property {string | null} checkedBy
 * @property {string | null} note
 * @property {ReadonlyArray<{ label: string, status: CheckStatus, note: string | null }>} entries
 */

/** KT5: Uygun, Uygun degil, Gerekmez, Bakilmadi */
export const STATUS_MARKS = Object.freeze({
  OK: "✅",
  NOT_OK: "❌",
  NOT_APPLICABLE: "➖",
  NOT_CHECKED: "⬜",
});

export const MESSAGE_TITLE = "Parti kontrolü";

/**
 * KT5: kopyalarken degisebilen her sey (WhatsApp bicim isaretleri, bosluklar, gorunmez isaretler,
 * emoji secicisi) koda katilmaz. FNV-1a 32 bit, 16 bite katlanir, 4 buyuk hex hane.
 * @param {string} text
 */
export function messageCode(text) {
  const normalized = text
    .normalize("NFC")
    .replace(/[*_~`\s\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFE0F\uFEFF]/g, "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash ^ (hash >>> 16)) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Tek satira indirir; bos ise null
 * @param {string | null | undefined} value
 */
function oneLine(value) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/**
 * KT5: okunur, programin cozebildigi sabit duzen
 * @param {PhoneCheck} check
 */
export function buildChecklistMessage(check) {
  const [year, month, day] = check.checkedOn.split("-");
  const lines = [MESSAGE_TITLE, `Parti no: ${oneLine(check.lotNumber) ?? ""}`];
  const productHint = oneLine(check.productHint);
  if (productHint !== null) lines.push(`Ürün: ${productHint}`);
  const productCode = oneLine(check.productCode);
  if (productCode !== null) lines.push(`Ürün kodu: ${productCode}`);
  lines.push(`Tarih: ${day}.${month}.${year}`);
  const checkedBy = oneLine(check.checkedBy);
  if (checkedBy !== null) lines.push(`Kontrol eden: ${checkedBy}`);
  lines.push("");
  check.entries.forEach((entry, index) => {
    const mark = STATUS_MARKS[entry.status];
    if (mark === undefined) throw new Error(`Bilinmeyen durum: ${entry.status}`);
    lines.push(`${mark} ${index + 1}. ${oneLine(entry.label) ?? ""}`);
    const note = oneLine(entry.note);
    if (note !== null) lines.push(`    Not: ${note}`);
  });
  const note = oneLine(check.note);
  if (note !== null) lines.push("", `Genel not: ${note}`);
  const code = messageCode(lines.join("\n"));
  lines.push(`(${check.entries.length} madde · kod ${code})`);
  return lines.join("\n");
}

/**
 * KT2: eski "#v1.<base64url(UTF-8 JSON)>" -> madde listesi; tanınmazsa null
 * @param {string} hash
 * @returns {string[] | null}
 */
function decodeItemsHash(hash) {
  const match = /^#?v1\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (match === null) return null;
  try {
    const base64 = (match[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const items = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      !items.every((item) => typeof item === "string" && item.trim() !== "")
    ) {
      return null;
    }
    return items;
  } catch {
    return null;
  }
}

/**
 * base64url -> bayt
 * @param {string} encoded
 */
function base64urlBytes(encoded) {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** @param {unknown} value */
const nonEmptyText = (value) => typeof value === "string" && value.trim() !== "";

/**
 * UL1: "#v1." (yalniz maddeler) ya da "#v2." (UTF-8 JSON {"i": maddeler, "p": [[kod, ad], ...]},
 * deflate-raw, base64url). Taninmazsa null. v2 icin tarayicida `DecompressionStream` gerekir.
 * @param {string} hash
 * @returns {Promise<{ items: string[], products: { code: string, name: string }[] } | null>}
 */
export async function decodeLinkHash(hash) {
  const v1 = decodeItemsHash(hash);
  if (v1 !== null) return { items: v1, products: [] };
  const match = /^#?v2\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (match === null) return null;
  try {
    const stream = new Blob([base64urlBytes(match[1] ?? "")])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    const bytes = await new Response(stream).arrayBuffer();
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const items = data?.i;
    const products = data?.p;
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      !items.every(nonEmptyText) ||
      !Array.isArray(products) ||
      !products.every(
        (product) =>
          Array.isArray(product) &&
          product.length === 2 &&
          nonEmptyText(product[0]) &&
          nonEmptyText(product[1]),
      )
    ) {
      return null;
    }
    return {
      items,
      products: products.map(([code, name]) => ({ code, name })),
    };
  } catch {
    return null;
  }
}
