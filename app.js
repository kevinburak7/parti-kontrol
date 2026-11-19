// @ts-check
/**
 * Parti kontrolu telefon formu (SPEC-inventory.md "Parti kontrolünü telefondan doldurma"
 * KT1-KT4; ADR 0054). Bagimliliksiz ES modulu. Veri yalniz telefonda (localStorage) durur,
 * disariya istek atilmaz; sonuc WhatsApp mesaji olarak paylasilir.
 */
import { buildChecklistMessage, decodeLinkHash, STATUS_MARKS } from "./message.js";

/** @typedef {import("./message.js").CheckStatus} CheckStatus */
/**
 * @typedef {object} StoredCheck
 * @property {string} id
 * @property {string} lotNumber
 * @property {string} productHint listeden secildiyse urunun adi
 * @property {string} [productCode] listeden secilen urunun kodu (UL2); serbest metinde yok
 * @property {string} checkedOn "YYYY-AA-GG"
 * @property {string} note
 * @property {{ label: string, status: CheckStatus, note: string }[]} entries
 * @property {boolean} sent
 * @property {number} createdAt
 */
/** @typedef {{ code: string, name: string }} Product */
/**
 * @typedef {object} Store
 * @property {string[] | null} items
 * @property {Product[]} products linkle gelen kumas listesi (UL1)
 * @property {string} checkedBy
 * @property {StoredCheck[]} checks
 */

const STORAGE_KEY = "parti-kontrol.v1";

/** UL2: aramada en fazla bu kadar urun */
const MAX_SUGGESTIONS = 8;

/** KL1-KL4, KT3 sinirlari */
const MAX = { lotNumber: 40, productHint: 80, checkedBy: 60, itemNote: 150, note: 500 };

/** @type {ReadonlyArray<{ value: CheckStatus, label: string }>} */
const STATUSES = [
  { value: "OK", label: "Uygun" },
  { value: "NOT_OK", label: "Uygun değil" },
  { value: "NOT_APPLICABLE", label: "Gerekmez" },
  { value: "NOT_CHECKED", label: "Bakılmadı" },
];

/** @returns {Store} */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      return {
        items: Array.isArray(parsed.items) ? parsed.items : null,
        products: Array.isArray(parsed.products) ? parsed.products : [],
        checkedBy: typeof parsed.checkedBy === "string" ? parsed.checkedBy : "",
        checks: Array.isArray(parsed.checks) ? parsed.checks : [],
      };
    }
  } catch {
    // bozuk kayit: bastan basla
  }
  return { items: null, products: [], checkedBy: "", checks: [] };
}

const store = load();

/** KT1: her dokunusta kaydedilir */
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/** @param {Date} date */
function isoDay(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "YYYY-AA-GG" -> "GG.AA.YYYY" */
function trDay(/** @type {string} */ iso) {
  return iso.split("-").reverse().join(".");
}

/**
 * Kucuk DOM yardimcisi; metin her zaman textContent ile yazilir.
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {Array<Node | string | null>} [children]
 * @returns {HTMLElement}
 */
function h(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2), /** @type {EventListener} */ (value));
    } else if (key === "className") {
      element.className = String(value);
    } else if (key in element && key !== "list") {
      // @ts-expect-error dinamik ozellik (value, checked, maxLength ...)
      element[key] = value;
    } else {
      element.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children) {
    if (child !== null) element.append(child);
  }
  return element;
}

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

/** Ust bilgi notu (link acildiginda) */
let notice = "";

/**
 * KT2, UL1: linkteki madde ve urun listesi telefona yazilir; yarim kontroller kendi maddeleri ve
 * secili urunleriyle kalir
 */
async function readLink() {
  if (location.hash === "") return;
  if (/^#v2\./.test(location.hash) && typeof DecompressionStream === "undefined") {
    notice = "Bu telefonun tarayıcısı eski. Güncelleyip linki yeniden açın.";
    return;
  }
  const decoded = await decodeLinkHash(location.hash);
  if (decoded === null) {
    notice = "Link tanınmadı. Size gönderilen linkin tamamını açın.";
    return;
  }
  const changed =
    JSON.stringify(decoded.items) !== JSON.stringify(store.items) ||
    JSON.stringify(decoded.products) !== JSON.stringify(store.products);
  store.items = decoded.items;
  store.products = decoded.products;
  save();
  if (changed) {
    notice =
      decoded.products.length === 0
        ? `Madde listesi alındı (${decoded.items.length} madde).`
        : `Liste alındı (${decoded.items.length} madde, ${decoded.products.length} ürün).`;
  }
}

/** UL2: Turkce buyuk-kucuk harf farki gozetmeden (I/ı, İ/i) */
function fold(/** @type {string} */ text) {
  return text.toLocaleLowerCase("tr").trim();
}

/** UL2: kodda ya da adda gecen ilk 8 urun */
function searchProducts(/** @type {string} */ query) {
  const needle = fold(query);
  if (needle === "") return [];
  return store.products
    .filter(
      (product) =>
        fold(product.code).includes(needle) || fold(product.name).includes(needle),
    )
    .slice(0, MAX_SUGGESTIONS);
}

function showList() {
  const checks = [...store.checks].sort((a, b) => b.createdAt - a.createdAt);
  app.replaceChildren(
    h("h1", {}, ["Parti Kontrolü"]),
    notice === "" ? "" : h("p", { className: "notice", role: "status" }, [notice]),
    store.items === null
      ? h("div", { className: "card" }, [
          h("p", {}, ["Madde listesi yok."]),
          h("p", { className: "muted" }, [
            "Size WhatsApp'tan gönderilen linki açın. Sonra bu sayfa internetsiz de açılır.",
          ]),
        ])
      : h("button", { className: "primary", type: "button", onclick: newCheck }, [
          "Yeni kontrol",
        ]),
    h("h2", { style: "margin-top:1.25rem" }, ["Kontroller"]),
    checks.length === 0
      ? h("p", { className: "muted" }, ["Henüz kontrol yok."])
      : h(
          "ul",
          { className: "checks", style: "margin-top:0.5rem" },
          checks.map((check) =>
            h("li", {}, [
              h(
                "button",
                {
                  type: "button",
                  className: "check-link",
                  onclick: () => showCheck(check.id),
                },
                [
                  h("span", {}, [
                    h("strong", {}, [check.lotNumber.trim() || "Parti no yok"]),
                    ` · ${trDay(check.checkedOn)}`,
                    check.productHint.trim() === ""
                      ? null
                      : h("span", { className: "muted", style: "display:block" }, [
                          check.productHint,
                        ]),
                  ]),
                  h("span", { className: check.sent ? "tag sent" : "tag" }, [
                    check.sent ? "Gönderildi" : "Gönderilmedi",
                  ]),
                ],
              ),
            ]),
          ),
        ),
  );
  notice = "";
  window.scrollTo(0, 0);
}

function newCheck() {
  if (store.items === null) return;
  /** @type {StoredCheck} */
  const check = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    lotNumber: "",
    productHint: "",
    checkedOn: isoDay(new Date()),
    note: "",
    entries: store.items.map((label) => ({
      label,
      status: /** @type {CheckStatus} */ ("NOT_CHECKED"),
      note: "",
    })),
    sent: false,
    createdAt: Date.now(),
  };
  store.checks.push(check);
  save();
  showCheck(check.id);
}

/** @param {StoredCheck} check */
function messageOf(check) {
  return buildChecklistMessage({
    lotNumber: check.lotNumber,
    productHint: check.productHint,
    productCode: check.productCode ?? null,
    checkedOn: check.checkedOn,
    checkedBy: store.checkedBy,
    note: check.note,
    entries: check.entries.map((entry) => ({
      label: entry.label,
      status: entry.status,
      note: entry.note,
    })),
  });
}

/** Paylasma yoksa ya da basarisizsa panoya */
async function copyText(/** @type {string} */ text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { value: text, readOnly: true });
    document.body.append(area);
    /** @type {HTMLTextAreaElement} */ (area).select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** @param {string} id */
function showCheck(id) {
  const found = store.checks.find((item) => item.id === id);
  if (found === undefined) {
    showList();
    return;
  }
  const check = found;

  const error = h("p", { className: "error", role: "alert" });
  const status = h("p", { className: "muted", role: "status" });
  const lotInput = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "text",
      name: "lotNumber",
      value: check.lotNumber,
      maxLength: MAX.lotNumber,
      autocomplete: "off",
      autocapitalize: "characters",
      required: true,
    })
  );

  /** KT4: duzeltilen kontrol yeniden gonderilmeli */
  function changed() {
    check.sent = false;
    save();
    status.textContent = "";
  }

  /** @param {HTMLInputElement | HTMLTextAreaElement} input @param {(v: string) => void} set */
  function bind(input, set) {
    input.addEventListener("input", () => {
      set(input.value);
      changed();
    });
    return input;
  }

  function validMessage() {
    error.textContent = "";
    if (check.lotNumber.trim() === "") {
      error.textContent = "Parti no yazın.";
      lotInput.focus();
      return null;
    }
    return messageOf(check);
  }

  function markSent(/** @type {string} */ text) {
    check.sent = true;
    save();
    status.textContent = text;
  }

  async function send() {
    const text = validMessage();
    if (text === null) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text });
        markSent("Gönderildi.");
        return;
      } catch (shareError) {
        if (shareError instanceof DOMException && shareError.name === "AbortError")
          return;
      }
    }
    await copy();
  }

  async function copy() {
    const text = validMessage();
    if (text === null) return;
    if (await copyText(text)) {
      markSent("Kopyalandı. WhatsApp'ta mesaj kutusuna yapıştırın.");
    } else {
      error.textContent = "Kopyalanamadı.";
    }
  }

  /**
   * UL2: secili urun "KOD · Ad" + Degistir; secili degilse arama / serbest metin, altinda
   * eslesen urunler
   */
  const productField = h("div", { className: "field" });
  function renderProduct(/** @type {boolean} */ focus) {
    if (check.productCode !== undefined) {
      productField.replaceChildren(
        h("span", { id: "urun-etiket" }, ["Ürün"]),
        h("div", { className: "selected-product" }, [
          h("span", {}, [`${check.productCode} · ${check.productHint}`]),
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                delete check.productCode;
                check.productHint = "";
                changed();
                renderProduct(true);
              },
            },
            ["Değiştir"],
          ),
        ]),
      );
      return;
    }
    const suggestions = h("ul", { className: "suggestions", id: "urun-onerileri" });
    const input = /** @type {HTMLInputElement} */ (
      h("input", {
        type: "text",
        name: "productHint",
        value: check.productHint,
        maxLength: MAX.productHint,
        autocomplete: "off",
        "aria-controls": "urun-onerileri",
      })
    );
    function showSuggestions() {
      suggestions.replaceChildren(
        ...searchProducts(input.value).map((product) =>
          h("li", {}, [
            h(
              "button",
              {
                type: "button",
                onclick: () => {
                  check.productCode = product.code;
                  // KT3 siniri; urun koddan bulunur, ad yalniz yardim
                  check.productHint = Array.from(product.name)
                    .slice(0, MAX.productHint)
                    .join("");
                  changed();
                  renderProduct(false);
                },
              },
              [h("strong", {}, [product.code]), ` ${product.name}`],
            ),
          ]),
        ),
      );
    }
    input.addEventListener("input", () => {
      check.productHint = input.value;
      changed();
      showSuggestions();
    });
    productField.replaceChildren(
      h("label", {}, [
        "Ürün / renk ",
        h("span", { className: "muted" }, [
          store.products.length === 0
            ? "(isteğe bağlı)"
            : "(isteğe bağlı; ad ya da kodla arayın, listede yoksa yazın)",
        ]),
        input,
      ]),
      suggestions,
    );
    showSuggestions();
    if (focus) input.focus();
  }
  renderProduct(false);

  const items = check.entries.map((entry, index) => {
    const labelId = `madde-${index + 1}`;
    return h("li", { className: "item" }, [
      h("div", { className: "item-label", id: labelId }, [
        h("small", {}, [`${index + 1}. `]),
        entry.label,
      ]),
      h(
        "div",
        { className: "statuses", role: "radiogroup", "aria-labelledby": labelId },
        STATUSES.map((option) =>
          h("label", { className: `s-${option.value}` }, [
            h("input", {
              type: "radio",
              name: labelId,
              value: option.value,
              checked: entry.status === option.value,
              onchange: () => {
                entry.status = option.value;
                changed();
              },
            }),
            h("span", { className: "mark", "aria-hidden": "true" }, [
              STATUS_MARKS[option.value],
            ]),
            option.label,
          ]),
        ),
      ),
      bind(
        /** @type {HTMLInputElement} */ (
          h("input", {
            type: "text",
            value: entry.note,
            maxLength: MAX.itemNote,
            placeholder: "Not",
            "aria-label": `${entry.label} notu`,
          })
        ),
        (value) => {
          entry.note = value;
        },
      ),
    ]);
  });

  app.replaceChildren(
    h("div", { className: "row", style: "justify-content:space-between" }, [
      h("button", { type: "button", onclick: showList }, ["‹ Kontroller"]),
      h(
        "button",
        {
          type: "button",
          className: "danger",
          onclick: () => {
            if (confirm("Bu kontrol telefondan silinsin mi?")) {
              store.checks = store.checks.filter((item) => item.id !== check.id);
              save();
              showList();
            }
          },
        },
        ["Sil"],
      ),
    ]),
    h("h1", {}, ["Parti Kontrolü"]),
    h("div", { className: "card" }, [
      h("label", { className: "field" }, [
        "Parti no",
        bind(lotInput, (value) => {
          check.lotNumber = value;
        }),
      ]),
      productField,
      h("label", { className: "field" }, [
        "Kontrol tarihi",
        bind(
          /** @type {HTMLInputElement} */ (
            h("input", {
              type: "date",
              name: "checkedOn",
              value: check.checkedOn,
              required: true,
            })
          ),
          (value) => {
            if (value !== "") check.checkedOn = value;
          },
        ),
      ]),
      h("label", { className: "field" }, [
        "Kontrol eden",
        bind(
          /** @type {HTMLInputElement} */ (
            h("input", {
              type: "text",
              name: "checkedBy",
              value: store.checkedBy,
              maxLength: MAX.checkedBy,
              autocomplete: "name",
            })
          ),
          (value) => {
            // KT3: telefonda hatirlanir
            store.checkedBy = value;
          },
        ),
      ]),
    ]),
    h("div", { className: "card" }, [h("ul", { className: "items" }, items)]),
    h("div", { className: "card" }, [
      h("label", { className: "field" }, [
        "Genel not",
        bind(
          /** @type {HTMLTextAreaElement} */ (
            h("textarea", {
              name: "note",
              rows: 3,
              value: check.note,
              maxLength: MAX.note,
            })
          ),
          (value) => {
            check.note = value;
          },
        ),
      ]),
    ]),
    h("div", { className: "actions" }, [
      error,
      h("div", { className: "row" }, [
        h("button", { type: "button", className: "primary", onclick: send }, ["Gönder"]),
        h("button", { type: "button", onclick: copy }, ["Kopyala"]),
      ]),
      status,
    ]),
  );
  if (check.sent)
    status.textContent = "Bu kontrol gönderildi. Düzeltirseniz yeniden gönderin.";
  window.scrollTo(0, 0);
}

await readLink();
showList();
window.addEventListener("hashchange", async () => {
  await readLink();
  showList();
});

// KT1: ilk acilistan sonra internetsiz de acilsin (HTTPS ya da localhost)
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    // calismazsa form yine de internetle acilir
  });
}
