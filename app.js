// Recipe Booklet for iPhone/iPad/any browser. Everything happens on the device; nothing is uploaded.
import * as pdfjsLib from "./vendor/pdf.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";
const Engine = window.makeBookletEngine(window.PDFLib);

const SWATCHES = [
  ["Navy", "#1f3b8c"], ["Forest", "#1e5e34"], ["Burgundy", "#7a1c2e"], ["Chocolate", "#5a3418"],
  ["Plum", "#5b2a6e"], ["Teal", "#0f5f66"], ["Black", "#000000"],
];
const DEFAULTS = { colour: "#1f3b8c", recolour: true, onlyDark: true, layout: "booklet",
                   paper: "Letter", trim: true, flipBacks: false };
const PREVIEW_SIDES = 12;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem("rb-settings") || "{}")); } catch (e) { /* private mode */ }
const saveSettings = () => { try { localStorage.setItem("rb-settings", JSON.stringify(settings)); } catch (e) { /* ignore */ } };

let items = [];          // { id, kind: "pdf"|"text", name, bytes?, pageCount?, range?, text? }
let nextId = 1;
let latest = null;       // last built booklet: { bytes, name }
let generation = 0;
let previewUrls = [];
let editingId = null;    // text item being edited in the sheet
const measured = new Map(); // item id -> { doc: Promise<pdfjs doc>, boxes: {} }

// ---------------------------------------------------------------- recipes list

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderItems() {
  $("empty").hidden = items.length > 0;
  $("items").innerHTML = items.map((it, i) => {
    const detail = it.kind === "pdf"
      ? `<span>${it.pageCount} page${it.pageCount === 1 ? "" : "s"}</span>
         <label class="pages">Pages <input class="range" data-id="${it.id}" value="${escapeHtml(it.range)}"
           placeholder="All" autocomplete="off" autocorrect="off" spellcheck="false"></label>`
      : `<span>Pasted text ·</span> <button class="link" style="font-size:14px;padding:0" data-act="edit" data-id="${it.id}">Edit</button>`;
    return `<li class="item">
      <div class="doc ${it.kind === "text" ? "text" : ""}"></div>
      <div class="meta"><div class="name">${escapeHtml(it.name)}</div><div class="detail">${detail}</div></div>
      <div class="item-btns">
        <button class="icon-btn" data-act="up" data-id="${it.id}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="icon-btn" data-act="down" data-id="${it.id}" aria-label="Move down" ${i === items.length - 1 ? "disabled" : ""}>↓</button>
        <button class="icon-btn del" data-act="del" data-id="${it.id}" aria-label="Remove">✕</button>
      </div>
    </li>`;
  }).join("");
}

$("items").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const i = items.findIndex((it) => it.id === Number(btn.dataset.id));
  if (i < 0) return;
  const act = btn.dataset.act;
  if (act === "del") {
    const [gone] = items.splice(i, 1);
    const m = measured.get(gone.id);
    if (m) { m.doc.then((d) => d.destroy()).catch(() => {}); measured.delete(gone.id); }
  } else if (act === "up" && i > 0) {
    [items[i - 1], items[i]] = [items[i], items[i - 1]];
  } else if (act === "down" && i < items.length - 1) {
    [items[i + 1], items[i]] = [items[i], items[i + 1]];
  } else if (act === "edit") {
    openSheet(items[i]);
    return;
  }
  renderItems();
  schedule();
});

$("items").addEventListener("input", (e) => {
  if (!e.target.classList.contains("range")) return;
  const it = items.find((x) => x.id === Number(e.target.dataset.id));
  it.range = e.target.value;
  let ok = true;
  try { Engine.parseRange(it.range, 9999); } catch (err) { ok = false; }
  e.target.classList.toggle("bad", !ok);
  if (ok) schedule();
});

$("addPdf").onclick = () => $("file").click();
$("file").onchange = async (e) => {
  for (const file of e.target.files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      items.push({ id: nextId++, kind: "pdf", name: file.name.replace(/(\.recipe)?\.pdf$/i, ""), bytes,
                   pageCount: doc.getPageCount(), range: "" });
    } catch (err) {
      alert(`"${file.name}" couldn't be opened as a PDF.`);
    }
  }
  e.target.value = "";
  renderItems();
  schedule();
};

// ---------------------------------------------------------------- paste sheet

function titleFromText(text) {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) || "Recipe";
  const clean = first.replace(/[^\p{L}\p{N}\p{P}\s]/gu, "").replace(/\s+/g, " ").trim();
  return (clean || "Recipe").slice(0, 60);
}

function openSheet(item) {
  editingId = item ? item.id : null;
  $("sheetTitle").textContent = item ? "Edit recipe" : "Paste recipe";
  $("sheetDone").textContent = item ? "Done" : "Add";
  $("recipeText").value = item ? item.text : "";
  $("sheet").hidden = false;
  if (!item) $("recipeText").focus();
}
const closeSheet = () => { $("sheet").hidden = true; $("recipeText").blur(); };

$("addText").onclick = () => openSheet(null);
$("sheetCancel").onclick = closeSheet;
$("sheetDone").onclick = () => {
  const text = $("recipeText").value.trim();
  if (text) {
    const existing = items.find((it) => it.id === editingId);
    if (existing) { existing.text = text; existing.name = titleFromText(text); }
    else items.push({ id: nextId++, kind: "text", name: titleFromText(text), text });
    renderItems();
    schedule();
  }
  closeSheet();
};
$("pasteBtn").onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) $("recipeText").value = t;
  } catch (e) {
    alert("Couldn't read the clipboard. Tap in the box, then tap and hold and choose Paste.");
  }
};

// ---------------------------------------------------------------- settings controls

function renderSwatches() {
  const box = $("swatches");
  const isPreset = SWATCHES.some(([, h]) => h === settings.colour);
  box.innerHTML = SWATCHES.map(([name, hex]) =>
    `<button class="swatch ${settings.colour === hex ? "on" : ""}" style="background:${hex};--ring:${hex === "#000000" ? "var(--sec)" : hex}"
       data-hex="${hex}" aria-label="${name}" title="${name}"></button>`).join("") +
    `<label class="swatch custom ${isPreset ? "" : "on"}" title="Any colour" aria-label="Choose any colour">
       <span class="dot" style="background:${settings.colour}"></span>
       <input type="color" id="customColour" value="${settings.colour}">
     </label>`;
  box.classList.toggle("off", !settings.recolour);
}
$("swatches").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-hex]");
  if (!b) return;
  setSetting("colour", b.dataset.hex);
});
$("swatches").addEventListener("input", (e) => {
  if (e.target.id === "customColour") {
    settings.colour = e.target.value;
    saveSettings();
    e.target.closest(".swatch").classList.add("on");
    e.target.previousElementSibling.style.background = e.target.value;
    document.querySelectorAll(".swatch[data-hex]").forEach((s) => s.classList.remove("on"));
    schedule();
  }
});
$("swatches").addEventListener("change", (e) => { if (e.target.id === "customColour") renderSwatches(); });

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  renderControls();
  schedule();
}

function renderControls() {
  renderSwatches();
  for (const key of ["recolour", "onlyDark", "trim", "flipBacks"]) $(key).checked = !!settings[key];
  $("onlyDark").disabled = !settings.recolour;
  for (const key of ["layout", "paper"]) {
    $(key).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === settings[key]));
  }
  const booklet = settings.layout === "booklet";
  $("layoutHint").textContent = booklet
    ? "Two pages per sheet, in the right order to fold the stack in half like a book. Print double-sided."
    : "Two pages per sheet, side by side in normal reading order. No folding needed.";
  $("flipRow").hidden = !booklet;
}
for (const key of ["recolour", "onlyDark", "trim", "flipBacks"]) {
  $(key).addEventListener("change", (e) => setSetting(key, e.target.checked));
}
for (const key of ["layout", "paper"]) {
  $(key).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) setSetting(key, b.dataset.v);
  });
}

// ---------------------------------------------------------------- measuring pages (for trimming + blank pages)

function openPdfjs(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

async function contentBox(doc, index) {
  const page = await doc.getPage(index + 1);
  const vp = page.getViewport({ scale: 0.5 });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const w = c.width, h = c.height;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      if (data[k] * 0.3 + data[k + 1] * 0.59 + data[k + 2] * 0.11 < 235) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  c.width = c.height = 0;
  page.cleanup();
  if (x1 < 0) return null; // blank page
  const [ax, ay] = vp.convertToPdfPoint(x0, y0);
  const [bx, by] = vp.convertToPdfPoint(x1 + 1, y1 + 1);
  return { left: Math.min(ax, bx), right: Math.max(ax, bx), bottom: Math.min(ay, by), top: Math.max(ay, by) };
}

async function measure(item, indexes) {
  let entry = measured.get(item.id);
  if (!entry) {
    entry = { doc: openPdfjs(item.bytes), boxes: {} };
    measured.set(item.id, entry);
  }
  const doc = await entry.doc;
  const out = {};
  for (const i of indexes) {
    if (!(i in entry.boxes)) entry.boxes[i] = await contentBox(doc, i);
    out[i] = entry.boxes[i];
  }
  return out;
}

// ---------------------------------------------------------------- preview

let timer = null;
function schedule() {
  latest = null;
  $("share").disabled = true;
  $("save").disabled = true;
  if (!items.length) {
    generation++;
    $("busy").textContent = "";
    $("status").textContent = "Add a recipe to get started.";
    showPreviewMessage("Your booklet preview will appear here.");
    return;
  }
  $("busy").textContent = "· Updating…";
  clearTimeout(timer);
  timer = setTimeout(buildPreview, 350);
}

function showPreviewMessage(text, isError) {
  previewUrls.forEach(URL.revokeObjectURL);
  previewUrls = [];
  $("preview").innerHTML = `<p class="${isError ? "error" : "empty"}">${escapeHtml(text)}</p>`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function bookletName() {
  const base = items.length === 1 ? items[0].name : "Recipe booklet";
  return `${base.replace(/[\\/:*?"<>|]/g, "")} - to print.pdf`;
}

async function buildPreview() {
  const gen = ++generation;
  const opts = { colour: hexToRgb(settings.colour), recolour: settings.recolour, onlyDark: settings.onlyDark,
                 layout: settings.layout, paper: settings.paper, trim: settings.trim, flipBacks: settings.flipBacks };
  try {
    const result = await Engine.build(items, opts, measure);
    if (gen !== generation) return;
    const doc = await openPdfjs(result.bytes);
    const width = Math.min($("preview").clientWidth - 28, 760) * Math.min(window.devicePixelRatio || 1, 2);
    const urls = [];
    const count = Math.min(doc.numPages, PREVIEW_SIDES);
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / base.width });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (opts.layout === "booklet") { // dashed fold line
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.lineWidth = Math.max(1, c.width / 500);
        ctx.setLineDash([c.width / 90, c.width / 110]);
        ctx.beginPath();
        ctx.moveTo(c.width / 2, c.height * 0.015);
        ctx.lineTo(c.width / 2, c.height * 0.985);
        ctx.stroke();
      }
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
      c.width = c.height = 0;
      urls.push(URL.createObjectURL(blob));
      if (gen !== generation) { urls.forEach(URL.revokeObjectURL); doc.destroy(); return; }
    }
    doc.destroy();

    previewUrls.forEach(URL.revokeObjectURL);
    previewUrls = urls;
    const booklet = opts.layout === "booklet";
    let html = urls.map((u, i) => {
      const cap = booklet ? `Sheet ${Math.floor(i / 2) + 1} · ${i % 2 ? "back" : "front"}` : `Sheet ${i + 1}`;
      return `<img class="sheet-img" src="${u}" alt="${cap}"><p class="caption">${cap}</p>`;
    }).join("");
    if (result.sides > urls.length) html += `<p class="caption">…and ${result.sides - urls.length} more</p>`;
    $("preview").innerHTML = html;

    latest = { bytes: result.bytes, name: bookletName() };
    $("share").disabled = false;
    $("save").disabled = false;
    $("busy").textContent = "";
    const sheets = `${result.sheets} sheet${result.sheets === 1 ? "" : "s"} of paper`;
    $("status").textContent = `${result.pages} page${result.pages === 1 ? "" : "s"} on ${sheets}` +
      (booklet ? " · print double-sided, then fold" : "");
  } catch (err) {
    if (gen !== generation) return;
    $("busy").textContent = "";
    $("status").textContent = "Something went wrong.";
    showPreviewMessage(err && err.message ? err.message : String(err), true);
  }
}

// ---------------------------------------------------------------- share / print

let tipTimer = null;
function showTip(text) {
  $("tip").textContent = text;
  $("tip").hidden = false;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => { $("tip").hidden = true; }, 7000);
}

// On phones both buttons open the share menu (the only way a web app can save or print a file);
// the tip at the top says which option to tap.
// On computers (Windows/Mac/Linux) the share menu can't save or print, so download the PDF instead.
const isPhone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function shareBooklet(tip, print = false) {
  if (!latest) return;
  const file = new File([latest.bytes], latest.name, { type: "application/pdf" });
  if (isPhone && navigator.canShare && navigator.canShare({ files: [file] })) {
    showTip(tip);
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // closed the share sheet
    }
  }
  const url = URL.createObjectURL(file);
  if (print && !isPhone) {
    // Opens in the browser's PDF viewer, which has its own Print button.
    window.open(url, "_blank");
    showTip("Print it double-sided, flip on short edge, actual size (100%).");
    setTimeout(() => URL.revokeObjectURL(url), 600000);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = latest.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (!isPhone) showTip("Saved to your Downloads folder. Open it and print double-sided, flip on short edge, actual size.");
}

$("save").onclick = () => shareBooklet("Tap “Save to Files”, pick a folder, then tap Save.");
$("share").onclick = () => shareBooklet("Tap “Print”. Turn on Double-sided.", true);
if (!isPhone) $("save").textContent = "Download PDF";

// ---------------------------------------------------------------- install hint + offline

const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let dismissed = false;
try { dismissed = localStorage.getItem("rb-install-dismissed") === "1"; } catch (e) { /* ignore */ }
$("install").hidden = !(isIOS && !standalone && !dismissed);
$("installClose").onclick = () => {
  $("install").hidden = true;
  try { localStorage.setItem("rb-install-dismissed", "1"); } catch (e) { /* ignore */ }
};

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // a new version was installed; switch to it unless you're in the middle of something
    if (!reloaded && !items.length) { reloaded = true; location.reload(); }
  });
}

// ---------------------------------------------------------------- start

renderControls();
renderItems();

// For testing: ?add=<same-site PDF path>
const add = new URLSearchParams(location.search).get("add");
if (add && !/^[a-z]+:|^\/\//i.test(add)) {
  fetch(add).then((r) => r.arrayBuffer()).then(async (buf) => {
    const bytes = new Uint8Array(buf);
    const doc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    items.push({ id: nextId++, kind: "pdf", name: decodeURIComponent(add.split("/").pop()).replace(/\.pdf$/i, ""),
                 bytes, pageCount: doc.getPageCount(), range: "" });
    renderItems();
    schedule();
  }).catch(() => {});
}
