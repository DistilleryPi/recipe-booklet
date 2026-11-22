/* Recipe Booklet engine: recolour PDF text and lay pages out as a booklet.
   Same approach as booklet_core.py, rewritten to run inside the browser (and Node, for tests). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.makeBookletEngine = factory;
})(typeof self !== "undefined" ? self : this, function (PDFLib) {
  "use strict";
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, StandardFonts,
          rgb, degrees, decodePDFRawStream } = PDFLib;

  const PAPER = { Letter: [792, 612], A4: [842, 595] }; // landscape sheet, points
  const enc = new TextEncoder();

  // ------------------------------------------------------------------ content stream reading

  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

  function ascii(b, s, e) {
    let out = "";
    for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
    return out;
  }

  function decodeName(b, s, e) {
    return ascii(b, s, e).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function skipInlineImage(b, i) {
    // After "ID" comes one whitespace byte, then raw image data ending in whitespace + "EI".
    const n = b.length;
    i++;
    while (i < n - 2) {
      if (WS.has(b[i]) && b[i + 1] === 69 && b[i + 2] === 73 && (i + 3 >= n || WS.has(b[i + 3]))) return i + 3;
      i++;
    }
    return n;
  }

  /** Split a content stream into instructions: { op, args, start, end } (byte positions). */
  function tokenize(b) {
    const ops = [];
    let args = [];
    let argStart = -1;
    let i = 0;
    const n = b.length;
    const push = (t, v, s) => {
      if (argStart < 0) argStart = s;
      args.push({ t, v });
    };
    while (i < n) {
      const c = b[i];
      if (WS.has(c)) { i++; continue; }
      const s = i;
      if (c === 37) { // % comment
        while (i < n && b[i] !== 10 && b[i] !== 13) i++;
        continue;
      }
      if (c === 40) { // (literal string)
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
          const d = b[i];
          if (d === 92) { i += 2; continue; }
          if (d === 40) depth++;
          else if (d === 41) depth--;
          i++;
        }
        push("str", null, s);
        continue;
      }
      if (c === 60) { // << or <hex>
        if (b[i + 1] === 60) { i += 2; push("<<", null, s); continue; }
        while (i < n && b[i] !== 62) i++;
        i++;
        push("hex", null, s);
        continue;
      }
      if (c === 62) {
        if (b[i + 1] === 62) { i += 2; push(">>", null, s); continue; }
        i++;
        continue;
      }
      if (c === 91 || c === 93) { i++; push(c === 91 ? "[" : "]", null, s); continue; }
      if (c === 123 || c === 125) { i++; continue; }
      if (c === 47) { // /Name
        i++;
        while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
        push("name", decodeName(b, s + 1, i), s);
        continue;
      }
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      const word = ascii(b, s, i);
      if (NUM_RE.test(word)) { push("num", parseFloat(word), s); continue; }
      if (word === "true" || word === "false" || word === "null") { push("kw", word, s); continue; }
      ops.push({ op: word, args, start: argStart < 0 ? s : argStart, end: i });
      args = [];
      argStart = -1;
      if (word === "ID") i = skipInlineImage(b, i);
    }
    return ops;
  }

  // ------------------------------------------------------------------ recolouring

  function toRgb(family, args) {
    const v = args.map((a) => a.v);
    if (args.some((a) => a.t !== "num")) return null; // pattern names etc.
    if (family === "gray" && v.length === 1) return [v[0], v[0], v[0]];
    if (family === "rgb" && v.length === 3) return v;
    if (family === "cmyk" && v.length === 4) {
      const [c, m, y, k] = v;
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
    return null;
  }

  const DIRECT = { DeviceGray: "gray", DeviceRGB: "rgb", DeviceCMYK: "cmyk", G: "gray", RGB: "rgb", CMYK: "cmyk" };

  function csFamily(name, resources) {
    if (DIRECT[name]) return DIRECT[name];
    try {
      const spaces = resources && resources.lookup(PDFName.of("ColorSpace"));
      if (!(spaces instanceof PDFDict)) return "other";
      const cs = spaces.lookup(PDFName.of(name));
      if (cs instanceof PDFName) return DIRECT[cs.decodeText ? cs.decodeText() : cs.toString().slice(1)] || "other";
      if (cs instanceof PDFArray && cs.size() > 0) {
        const kind = cs.lookup(0).toString();
        if (kind === "/ICCBased") {
          const stream = cs.lookup(1);
          const n = stream.dict.lookup(PDFName.of("N"));
          return { 1: "gray", 3: "rgb", 4: "cmyk" }[n ? n.asNumber() : 0] || "other";
        }
        if (kind === "/CalGray") return "gray";
        if (kind === "/CalRGB") return "rgb";
      }
    } catch (e) { /* unusual colour space: leave it alone */ }
    return "other";
  }

  function shouldRecolour(state, onlyDark) {
    if (state.inherited && !state.col) return true; // most likely plain black text
    const c = state.rgb;
    if (!c) return false;
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (onlyDark) return lum < 0.55 && Math.max(...c) - Math.min(...c) < 0.25;
    return lum < 0.85; // never darken white text on a dark banner
  }

  function restoreText(state) {
    if (state.col && /\s(g|rg|k)$/.test(state.col)) return state.col;
    const parts = [state.cs, state.col].filter(Boolean);
    return parts.length ? parts.join(" ") : "0 g";
  }

  const fmt = (x) => (Math.round(x * 1000) / 1000).toString();

  function gsAlpha(name, resources) {
    try {
      const gs = resources.lookup(PDFName.of("ExtGState")).lookup(PDFName.of(name));
      const ca = gs.lookup(PDFName.of("ca"));
      return ca ? ca.asNumber() : 1;
    } catch (e) {
      return 1;
    }
  }

  /** Returns { bytes (or null if unchanged), recoloured }. opaque(resources) gives a "gs" that makes fill solid. */
  function recolourStream(bytes, resources, target, onlyDark, inherited, visitForm, opaque) {
    const ops = tokenize(bytes);
    const targetText = ` ${target.map(fmt).join(" ")} rg `;
    let state = { family: "gray", cs: null, col: null, rgb: [0, 0, 0], inherited, gs: null, alpha: 1 };
    const stack = [];
    let inText = false;
    let showing = false; // the real fill colour is currently our target colour
    let forced = false;  // we've made faded text solid (websites fade some text, e.g. recipe notes)
    let recoloured = false;
    const out = [];
    let last = 0;
    const insert = (pos, text) => {
      out.push(bytes.subarray(last, pos), enc.encode(text));
      last = pos;
    };
    const slice = (ins) => ascii(bytes, ins.start, ins.end);
    const restore = () => {
      let t = showing ? restoreText(state) : "";
      if (forced && state.gs) t += " " + state.gs;
      return ` ${t} `;
    };

    for (const ins of ops) {
      const { op, args } = ins;
      if (op === "q") {
        stack.push([{ ...state }, showing, forced]);
      } else if (op === "Q") {
        if (stack.length) [state, showing, forced] = stack.pop();
      } else if (op === "BT") {
        inText = true;
      } else if (op === "ET") {
        if (showing || forced) {
          insert(ins.end, restore());
          showing = forced = false;
        }
        inText = false;
      } else if (op === "gs" && args[0] && args[0].t === "name") {
        state.gs = slice(ins);
        state.alpha = gsAlpha(args[0].v, resources);
        forced = false;
      } else if (op === "cs") {
        const fam = args[0] && args[0].t === "name" ? csFamily(args[0].v, resources) : "other";
        state = { family: fam, cs: slice(ins), col: null, rgb: fam === "other" ? null : [0, 0, 0], inherited: false };
        showing = false;
      } else if (op === "g" || op === "rg" || op === "k" || op === "sc" || op === "scn") {
        const fam = { g: "gray", rg: "rgb", k: "cmyk" }[op];
        if (fam) { state.family = fam; state.cs = null; }
        state.col = slice(ins);
        state.inherited = false;
        state.rgb = toRgb(state.family, args);
        showing = false;
      } else if (inText && (op === "Tj" || op === "TJ" || op === "'" || op === '"')) {
        const want = shouldRecolour(state, onlyDark);
        if (want) {
          recoloured = true;
          let t = "";
          if (!showing) { t += targetText; showing = true; }
          if (state.alpha < 0.999 && !forced) { t += ` ${opaque(resources)} `; forced = true; }
          if (t) insert(ins.start, t);
        } else if (showing || forced) {
          insert(ins.start, restore());
          showing = forced = false;
        }
      } else if (op === "Do" && args[0] && args[0].t === "name") {
        if (visitForm(args[0].v, resources)) {
          recoloured = true;
          if (state.alpha < 0.999) { // a faded layer holding recoloured text: draw it solid
            insert(ins.start, ` ${opaque(resources)} `);
            if (state.gs) insert(ins.end, ` ${state.gs} `);
          }
        }
      }
    }
    if (!out.length) return { bytes: null, recoloured };
    out.push(bytes.subarray(last));
    return { bytes: concat(out), recoloured };
  }

  function concat(parts) {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const res = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { res.set(p, o); o += p.length; }
    return res;
  }

  function streamBytes(stream) {
    return decodePDFRawStream(stream).decode();
  }

  /** Change the colour of text on every page of a pdf-lib document, in place. */
  function recolourDoc(doc, target, onlyDark) {
    const ctx = doc.context;
    const seen = new Map(); // form -> whether it holds recoloured text
    let opaqueRef = null;
    const opaque = (resources) => {
      if (!opaqueRef) opaqueRef = ctx.register(ctx.obj({ Type: "ExtGState", ca: 1, CA: 1 }));
      let gs = resources.lookup(PDFName.of("ExtGState"));
      if (!(gs instanceof PDFDict)) {
        gs = ctx.obj({});
        resources.set(PDFName.of("ExtGState"), gs);
      }
      gs.set(PDFName.of("RBOpaque"), opaqueRef);
      return "/RBOpaque gs";
    };
    const visitForm = (name, resources) => {
      if (!(resources instanceof PDFDict)) return false;
      const xobjs = resources.lookup(PDFName.of("XObject"));
      if (!(xobjs instanceof PDFDict)) return false;
      const ref = xobjs.get(PDFName.of(name));
      if (!(ref instanceof PDFRef)) return false;
      if (seen.has(ref.toString())) return seen.get(ref.toString());
      seen.set(ref.toString(), false);
      const stream = ctx.lookup(ref);
      if (!(stream instanceof PDFRawStream)) return false;
      const sub = stream.dict.lookup(PDFName.of("Subtype"));
      if (!sub || sub.toString() !== "/Form") return false;
      const own = stream.dict.lookup(PDFName.of("Resources"));
      const res = own instanceof PDFDict ? own : resources;
      const { bytes: out, recoloured } = recolourStream(streamBytes(stream), res, target, onlyDark, true, visitForm, opaque);
      seen.set(ref.toString(), recoloured);
      if (!out) return recoloured;
      const fresh = ctx.flateStream(out);
      for (const [k, v] of stream.dict.entries()) {
        if (!["/Filter", "/DecodeParms", "/Length"].includes(k.toString())) fresh.dict.set(k, v);
      }
      ctx.assign(ref, fresh);
      return recoloured;
    };

    for (const page of doc.getPages()) {
      const node = page.node;
      const contents = node.Contents();
      if (!contents) continue;
      const streams = contents instanceof PDFArray
        ? contents.asArray().map((r) => ctx.lookup(r))
        : [contents];
      const parts = [];
      for (const s of streams) {
        if (s instanceof PDFRawStream) parts.push(streamBytes(s), enc.encode("\n"));
      }
      if (!parts.length) continue;
      const { bytes: out } = recolourStream(concat(parts), node.Resources(), target, onlyDark, false, visitForm, opaque);
      if (out) node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(out)));
    }
  }

  // ------------------------------------------------------------------ text recipes (e.g. Instagram captions)

  const REPLACE = {
    "⅓": "1/3", "⅔": "2/3", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅕": "1/5",
    "⅖": "2/5", "⅗": "3/5", "⅘": "4/5", "⅙": "1/6", "⅚": "5/6", "⁄": "/", "→": "->",
    "−": "-", "℃": "°C", "℉": "°F", " ": " ", " ": " ", " ": " ", "\t": " ",
  };
  const HEADING_RE = /^(ingredients?|method|instructions?|directions?|steps?|notes?|tips?|equipment|to serve|serves|for the\b.*|you('ll)? (will )?need)\b/i;

  function cleaner(font) {
    const ok = new Map();
    const canEncode = (ch) => {
      if (!ok.has(ch)) {
        try { font.encodeText(ch); ok.set(ch, true); } catch (e) { ok.set(ch, false); }
      }
      return ok.get(ch);
    };
    return (text) => {
      let s = "";
      for (const ch of text) {
        const r = REPLACE[ch] !== undefined ? REPLACE[ch] : ch;
        for (const c of r) if (canEncode(c)) s += c;
      }
      return s.replace(/\s+/g, " ").trim();
    };
  }

  function wrap(text, font, size, width) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(test, size) <= width || !line) line = test;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    // break any single word that's still too long (e.g. long links)
    return lines.flatMap((l) => {
      if (font.widthOfTextAtSize(l, size) <= width) return [l];
      const bits = [];
      let cur = "";
      for (const ch of l) {
        if (font.widthOfTextAtSize(cur + ch, size) > width && cur) { bits.push(cur); cur = ""; }
        cur += ch;
      }
      if (cur) bits.push(cur);
      return bits;
    });
  }

  /** Turn pasted recipe text into PDF pages (half a sheet each). Returns bytes. */
  async function textRecipe(text, o) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const clean = cleaner(font);
    const [W, H] = PAPER[o.paper];
    const pw = W / 2, ph = H;
    const mx = 30, top = 34, bottom = 34;
    const colour = o.recolour ? rgb(...o.colour) : rgb(0, 0, 0);
    const body = 10.5, lead = 14.2;
    const width = pw - 2 * mx;

    let page = null, y = 0;
    const newPage = () => { page = doc.addPage([pw, ph]); y = ph - top; };
    const room = (h) => { if (!page || y - h < bottom) newPage(); };

    const lines = text.replace(/\r/g, "").split("\n");
    let titleDone = false;
    let pendingGap = 0;
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) { pendingGap = titleDone ? 6 : 0; continue; }
      if (/^([#@][\p{L}\p{N}_.]+[\s,]*)+$/u.test(trimmed)) continue; // hashtag / mention lines
      const startsWithSymbol = /^[^\p{L}\p{N}("'¼½¾]/u.test(trimmed);
      let line = clean(trimmed);
      if (!line) continue;

      if (!titleDone) {
        const tl = wrap(line, bold, 17, width);
        room(tl.length * 21);
        for (const t of tl) { page.drawText(t, { x: mx, y: y - 17, size: 17, font: bold, color: colour }); y -= 21; }
        y -= 8;
        titleDone = true;
        pendingGap = 0;
        continue;
      }
      const numbered = /^\d+[.)]\s+/.test(line);
      const heading = !numbered && line.length <= 45 && (/:$/.test(line) || HEADING_RE.test(line));
      if (heading) {
        y -= Math.max(pendingGap, 8);
        pendingGap = 0;
        room(16 + 2 * lead); // keep a heading with at least two lines after it
        page.drawText(line, { x: mx, y: y - 12.5, size: 12.5, font: bold, color: colour });
        y -= 19;
        continue;
      }
      y -= pendingGap;
      pendingGap = 0;
      let marker = null;
      if (numbered) {
        const m = line.match(/^(\d+[.)])\s+/);
        marker = m[1];
        line = line.slice(m[0].length);
      } else if (startsWithSymbol || /^[-*•]\s*/.test(line)) {
        marker = "•";
        line = line.replace(/^[-*•]\s*/, "");
        if (!line) continue;
      }
      const indent = marker ? 14 : 0;
      const wrapped = wrap(line, font, body, width - indent);
      wrapped.forEach((t, i) => {
        room(lead);
        if (i === 0 && marker) page.drawText(marker, { x: mx, y: y - body, size: body, font, color: colour });
        page.drawText(t, { x: mx + indent, y: y - body, size: body, font, color: colour });
        y -= lead;
      });
      y -= 2;
    }
    if (!page) newPage();
    return doc.save();
  }

  // ------------------------------------------------------------------ page ranges

  function parseRange(text, count) {
    text = (text || "").trim();
    if (!text) return [...Array(count).keys()];
    const pages = [];
    for (let part of text.replace(/;/g, ",").split(",")) {
      part = part.trim();
      if (!part) continue;
      let m;
      if ((m = part.match(/^(\d*)\s*-\s*(\d*)$/))) {
        const a = m[1] ? parseInt(m[1], 10) : 1;
        const b = m[2] ? parseInt(m[2], 10) : count;
        for (let p = a; p <= Math.min(b, count); p++) pages.push(p - 1);
      } else if (/^\d+$/.test(part)) {
        const p = parseInt(part, 10);
        if (p >= 1 && p <= count) pages.push(p - 1);
      } else {
        throw new Error(`Couldn't understand the pages "${text}". Use numbers like 1-3 or 1, 3.`);
      }
    }
    return pages;
  }

  // ------------------------------------------------------------------ the whole job

  /**
   * items: [{ kind: "pdf", bytes, range, id } | { kind: "text", text, id }]
   * measure(item, pageIndexes) -> { index: {left,bottom,right,top} | null (blank) }   (optional)
   */
  async function build(items, opts, measure) {
    const o = Object.assign({ colour: [0.12, 0.23, 0.55], onlyDark: true, recolour: true, paper: "Letter",
                              layout: "booklet", trim: true, skipBlank: true, flipBacks: false }, opts);
    const [W, H] = PAPER[o.paper];
    const slots = [];

    for (const it of items) {
      if (it.kind === "text") {
        const doc = await PDFDocument.load(await textRecipe(it.text, o));
        doc.getPages().forEach((_, i) => slots.push({ doc, index: i, box: null }));
        continue;
      }
      const doc = await PDFDocument.load(it.bytes, { updateMetadata: false, ignoreEncryption: true });
      if (doc.isEncrypted) throw new Error(`"${it.name}" is locked, so it can't be changed.`);
      if (o.recolour) recolourDoc(doc, o.colour, o.onlyDark);
      const wanted = parseRange(it.range, doc.getPageCount());
      const boxes = measure ? await measure(it, wanted) : {};
      const kept = wanted.filter((i) => !(o.skipBlank && boxes[i] === null));
      let union = null;
      for (const i of kept) {
        const b = boxes[i];
        if (!b) continue;
        union = union ? { left: Math.min(union.left, b.left), bottom: Math.min(union.bottom, b.bottom),
                          right: Math.max(union.right, b.right), top: Math.max(union.top, b.top) } : { ...b };
      }
      for (const i of kept) {
        const c = doc.getPage(i).getCropBox();
        let box = { left: c.x, bottom: c.y, right: c.x + c.width, top: c.y + c.height };
        if (o.trim && union) {
          box = { left: Math.max(box.left, union.left - 6), bottom: Math.max(box.bottom, union.bottom - 6),
                  right: Math.min(box.right, union.right + 6), top: Math.min(box.top, union.top + 6) };
        }
        slots.push({ doc, index: i, box });
      }
    }
    if (!slots.length) throw new Error("No pages to print. The PDFs look empty, or the page numbers skip everything.");

    const out = await PDFDocument.create();
    out.setTitle("Recipe booklet");
    out.setCreator("Recipe Booklet");
    const embedded = [];
    for (const s of slots) {
      const page = s.doc.getPage(s.index);
      if (!page.node.Contents()) { // a completely empty page: give it empty contents so it can be placed
        page.node.set(PDFName.of("Contents"), s.doc.context.register(s.doc.context.flateStream(new Uint8Array(0))));
      }
      embedded.push(await out.embedPage(page, s.box || undefined));
    }

    const halfW = W / 2, margin = 18, gutter = 14;
    const place = (sheet, e, side) => {
      if (!e) return;
      const x0 = side === 0 ? margin : halfW + gutter;
      const x1 = side === 0 ? halfW - gutter : W - margin;
      const tw = x1 - x0, th = H - 2 * margin;
      const scale = Math.min(tw / e.width, th / e.height);
      const w = e.width * scale, h = e.height * scale;
      sheet.drawPage(e, { x: x0 + (tw - w) / 2, y: H - margin - h, width: w, height: h });
    };

    let order;
    if (o.layout === "booklet") {
      const pages = embedded.concat(Array((4 - (embedded.length % 4)) % 4).fill(null));
      const n = pages.length;
      order = [];
      for (let s = 0; s < n / 4; s++) {
        order.push([pages[n - 1 - 2 * s], pages[2 * s]]);      // front of sheet
        order.push([pages[2 * s + 1], pages[n - 2 - 2 * s]]);  // back of sheet
      }
    } else {
      const pages = embedded.concat(embedded.length % 2 ? [null] : []);
      order = [];
      for (let i = 0; i < pages.length; i += 2) order.push([pages[i], pages[i + 1]]);
    }
    order.forEach(([l, r], i) => {
      const sheet = out.addPage([W, H]);
      place(sheet, l, 0);
      place(sheet, r, 1);
      if (o.layout === "booklet" && o.flipBacks && i % 2 === 1) sheet.setRotation(degrees(180));
    });

    const sheets = o.layout === "booklet" ? order.length / 2 : order.length;
    return { bytes: await out.save(), pages: slots.length, sheets, sides: order.length };
  }

  return { build, parseRange, recolourDoc, textRecipe, tokenize, PAPER };
});
