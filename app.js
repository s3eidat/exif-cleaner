/* EXIF Cleaner — own JPEG/PNG/TIFF parsers. Cleaning drops metadata segments and copies image data byte for byte. */
(function () {
  "use strict";
  const $ = S3.$;
  const ascii = (b, s, n) => { let r = ""; for (let i = s; i < s + n && i < b.length; i++) r += String.fromCharCode(b[i]); return r; };
  const concat = parts => { const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n); let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; }); return out; };

  // ---------- TIFF / EXIF ----------
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const IFD0 = { 0x010F: "Camera make", 0x0110: "Camera model", 0x0131: "Software", 0x0132: "Date modified", 0x013B: "Artist", 0x8298: "Copyright", 0x010E: "Description", 0x0112: "Orientation" };
  const EXIF = { 0x9003: "Date taken", 0xA434: "Lens", 0xA431: "Camera serial number", 0xA430: "Camera owner", 0x829D: "Aperture", 0x829A: "Exposure", 0x8827: "ISO", 0x920A: "Focal length", 0xA420: "Unique image ID" };
  const SENSITIVE = { "Camera serial number": 1, "Camera owner": 1, "Artist": 1, "Unique image ID": 1, "Date taken": 1 };

  // Parses a TIFF block (starting at "II*\0" / "MM\0*"). Every read is bounds-checked; damaged data is skipped, never trusted.
  function parseTiff(b) {
    if (b.length < 8) throw new Error("EXIF too short");
    const le = b[0] === 0x49 && b[1] === 0x49;
    if (!le && !(b[0] === 0x4D && b[1] === 0x4D)) throw new Error("Bad EXIF byte order");
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), L = b.length;
    if (v.getUint16(2, le) !== 42) throw new Error("Bad EXIF header");
    function ifd(off) {
      const tags = {};
      if (off < 8 || off + 2 > L) return tags;
      const n = v.getUint16(off, le);
      for (let i = 0; i < Math.min(n, 400); i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > L) break;
        const tag = v.getUint16(e, le), type = v.getUint16(e + 2, le), count = v.getUint32(e + 4, le), sz = TYPE_SIZE[type];
        if (!sz || count > 1e6) continue;
        const size = sz * count, at = size <= 4 ? e + 8 : v.getUint32(e + 8, le);
        if (at + size > L) continue;
        let val;
        if (type === 2) val = ascii(b, at, count).replace(/\0[\s\S]*$/, "").trim();
        else if (type === 3) val = Array.from({ length: Math.min(count, 64) }, (_, k) => v.getUint16(at + 2 * k, le));
        else if (type === 4 || type === 9) val = Array.from({ length: Math.min(count, 64) }, (_, k) => type === 4 ? v.getUint32(at + 4 * k, le) : v.getInt32(at + 4 * k, le));
        else if (type === 5 || type === 10) val = Array.from({ length: Math.min(count, 64) }, (_, k) => {
          const n1 = type === 5 ? v.getUint32(at + 8 * k, le) : v.getInt32(at + 8 * k, le), d = type === 5 ? v.getUint32(at + 8 * k + 4, le) : v.getInt32(at + 8 * k + 4, le);
          return d ? n1 / d : 0;
        });
        else val = b.subarray(at, at + Math.min(size, 256));
        tags[tag] = val;
      }
      return tags;
    }
    const t0 = ifd(v.getUint32(4, le));
    const ex = t0[0x8769] ? ifd(t0[0x8769][0]) : {}, gp = t0[0x8825] ? ifd(t0[0x8825][0]) : {};
    const fields = [], one = x => Array.isArray(x) ? x[0] : x;
    const fmt = (tag, val) => {
      const x = one(val);
      if (tag === 0x829D) return "f/" + (+x).toFixed(1);
      if (tag === 0x829A) return x >= 1 ? x + " s" : "1/" + Math.round(1 / x) + " s";
      if (tag === 0x920A) return (+x).toFixed(1).replace(/\.0$/, "") + " mm";
      return typeof val === "string" ? val : val instanceof Uint8Array ? null : String(x);
    };
    [[IFD0, t0], [EXIF, ex]].forEach(pair => Object.keys(pair[0]).forEach(k => {
      const tag = +k, val = pair[1][tag];
      if (val == null || tag === 0x0112) return;
      const s = fmt(tag, val);
      if (s) fields.push({ label: pair[0][k], value: s.slice(0, 300), sensitive: !!SENSITIVE[pair[0][k]] });
    }));
    let gps = null;
    const dms = a => Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null;
    const lat = dms(gp[2]), lon = dms(gp[4]);
    if (lat != null && lon != null && (lat || lon)) {
      gps = { lat: /S/i.test(gp[1] || "") ? -lat : lat, lon: /W/i.test(gp[3] || "") ? -lon : lon };
      if (gp[6]) gps.alt = (gp[5] && gp[5][0] === 1 ? -1 : 1) * one(gp[6]);
    }
    if (Object.keys(gp).length && !gps) fields.push({ label: "GPS data", value: "present (no coordinates)", sensitive: true });
    return { fields, gps, orientation: t0[0x0112] ? one(t0[0x0112]) : 1 };
  }
  // Writes a TIFF/EXIF payload ("Exif\0\0" + TIFF). entries: {ifd0:[[tag,type,value]], exif:[], gps:[]}.
  // Used for the orientation-only EXIF the cleaner keeps, and by the self-test to build sample photos.
  function buildExif(entries, le) {
    const groups = { ifd0: (entries.ifd0 || []).slice(), exif: (entries.exif || []).slice(), gps: (entries.gps || []).slice() };
    if (groups.exif.length) groups.ifd0.push([0x8769, 4, 0]);
    if (groups.gps.length) groups.ifd0.push([0x8825, 4, 0]);
    const names = ["ifd0", "exif", "gps"].filter(k => k === "ifd0" || groups[k].length);
    names.forEach(k => groups[k].sort((a, b) => a[0] - b[0]));
    const bytesOf = e => e[1] === 2 ? e[2].length + 1 : e[1] === 3 ? 2 * [].concat(e[2]).length : e[1] === 4 ? 4 * [].concat(e[2]).length : 8 * e[2].length;
    let off = 8; const at = {};
    names.forEach(k => { at[k] = off; off += 2 + groups[k].length * 12 + 4; });
    let data = off; const total = names.reduce((s, k) => s + groups[k].reduce((t, e) => t + (bytesOf(e) > 4 ? bytesOf(e) + (bytesOf(e) & 1) : 0), 0), off);
    const b = new Uint8Array(6 + total), v = new DataView(b.buffer, 6);
    b.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
    b[6] = b[7] = le ? 0x49 : 0x4D; v.setUint16(2, 42, le); v.setUint32(4, 8, le);
    groups.ifd0.forEach(e => { if (e[0] === 0x8769) e[2] = at.exif; if (e[0] === 0x8825) e[2] = at.gps; });
    names.forEach(k => {
      const list = groups[k]; let p = at[k];
      v.setUint16(p, list.length, le); p += 2;
      list.forEach(e => {
        const n = bytesOf(e), dst = n > 4 ? data : p + 8;
        v.setUint16(p, e[0], le); v.setUint16(p + 2, e[1], le);
        v.setUint32(p + 4, e[1] === 2 ? e[2].length + 1 : e[1] === 5 ? e[2].length : [].concat(e[2]).length, le);
        if (n > 4) { v.setUint32(p + 8, data, le); data += n + (n & 1); }
        if (e[1] === 2) for (let i = 0; i < e[2].length; i++) v.setUint8(dst + i, e[2].charCodeAt(i) & 0xFF);
        else if (e[1] === 3) [].concat(e[2]).forEach((x, i) => v.setUint16(dst + 2 * i, x, le));
        else if (e[1] === 4) [].concat(e[2]).forEach((x, i) => v.setUint32(dst + 4 * i, x, le));
        else e[2].forEach((r, i) => { v.setUint32(dst + 8 * i, r[0], le); v.setUint32(dst + 8 * i + 4, r[1], le); });
        p += 12;
      });
      v.setUint32(p, 0, le);
    });
    return b;
  }
  function app1(payload) { const s = new Uint8Array(4 + payload.length); s[0] = 0xFF; s[1] = 0xE1; s[2] = (payload.length + 2) >> 8; s[3] = (payload.length + 2) & 0xFF; s.set(payload, 4); return s; }

  // ---------- JPEG ----------
  function jpegSegments(b) {
    if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error("Not a JPEG file");
    const segs = [{ m: 0xD8, start: 0, end: 2 }];
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xFF) throw new Error("Damaged JPEG (no marker at byte " + i + ")");
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD9) { segs.push({ m, start: i, end: i + 2 }); return { segs, end: i + 2 }; }
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { segs.push({ m, start: i, end: i + 2 }); i += 2; continue; }
      if (i + 4 > b.length) break;
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2 || i + 2 + len > b.length) throw new Error("Damaged JPEG (segment runs past the end)");
      if (m === 0xDA) {
        // Scan data: walk to the real EOI, stepping over any tables between progressive scans.
        let j = i + 2 + len;
        while (j < b.length - 1) {
          if (b[j] !== 0xFF) { j++; continue; }
          const n = b[j + 1];
          if (n === 0x00 || n === 0xFF || (n >= 0xD0 && n <= 0xD7)) { j += n === 0xFF ? 1 : 2; continue; }
          if (n === 0xD9) { segs.push({ m, start: i, end: j }, { m: 0xD9, start: j, end: j + 2 }); return { segs, end: j + 2 }; }
          const l2 = (b[j + 2] << 8) | b[j + 3];
          if (l2 < 2) { j += 2; continue; }
          j += 2 + l2;
        }
        segs.push({ m, start: i, end: b.length });   // no EOI: keep what is there
        return { segs, end: b.length };
      }
      segs.push({ m, start: i, end: i + 2 + len });
      i += 2 + len;
    }
    return { segs, end: i };
  }
  function segId(b, s) { return ascii(b, s.start + 4, Math.min(30, s.end - s.start - 4)); }
  function inspectJpeg(b) {
    const { segs, end } = jpegSegments(b), blocks = [];
    let meta = { fields: [], gps: null, orientation: 1 };
    segs.forEach(s => {
      const id = segId(b, s), size = s.end - s.start;
      if (s.m === 0xE1 && id.indexOf("Exif\0") === 0) {
        blocks.push(["EXIF", size]);
        try { const r = parseTiff(b.subarray(s.start + 10, s.end)); meta = { fields: meta.fields.concat(r.fields), gps: r.gps || meta.gps, orientation: r.orientation }; }
        catch (e) { meta.fields.push({ label: "EXIF", value: "present but damaged (" + e.message + ")" }); }
      } else if (s.m === 0xE1 && /^https?:..ns.adobe.com.xap/.test(id) /* XMP namespace id, not a request */) {
        blocks.push(["XMP", size]);
        const xmp = new TextDecoder().decode(b.subarray(s.start + 33, s.end));
        const tool = /CreatorTool[=>"]+([^"<]{1,120})/.exec(xmp);
        if (tool) meta.fields.push({ label: "Edited with", value: tool[1] });
        if (/GPSLatitude/.test(xmp)) meta.fields.push({ label: "GPS (XMP)", value: "present", sensitive: true });
      } else if (s.m === 0xE1) blocks.push(["APP1 data", size]);
      else if (s.m === 0xE2 && id.indexOf("ICC_PROFILE") === 0) blocks.push(["ICC color profile", size]);
      else if (s.m === 0xE2 && id.indexOf("MPF") === 0) blocks.push(["Multi-picture index", size]);
      else if (s.m === 0xED) blocks.push(["IPTC / Photoshop", size]);
      else if (s.m === 0xFE) { blocks.push(["Comment", size]); meta.fields.push({ label: "Comment", value: new TextDecoder().decode(b.subarray(s.start + 4, Math.min(s.end, s.start + 304))) }); }
      else if (s.m === 0xE0 && id.indexOf("JFIF") !== 0) blocks.push(["APP0 " + id.replace(/\0.*$/, ""), size]);
      else if (s.m >= 0xE2 && s.m <= 0xEF && s.m !== 0xEE) blocks.push(["APP" + (s.m - 0xE0) + " data", size]);
    });
    if (end < b.length) blocks.push(["Data after the image (embedded previews / depth maps)", b.length - end]);
    return { type: "jpeg", blocks, meta };
  }
  function cleanJpeg(b, opt) {
    const { segs } = jpegSegments(b), parts = [];
    let orientation = 1;
    segs.forEach(s => {
      if (s.m === 0xE1 && segId(b, s).indexOf("Exif\0") === 0) { try { orientation = parseTiff(b.subarray(s.start + 10, s.end)).orientation; } catch (e) { /* damaged EXIF: dropped anyway */ } }
    });
    segs.forEach(s => {
      const id = segId(b, s);
      const isApp = s.m >= 0xE0 && s.m <= 0xEF;
      let keep = !isApp && s.m !== 0xFE;
      if (s.m === 0xE0 && id.indexOf("JFIF\0") === 0) keep = true;
      if (s.m === 0xE2 && id.indexOf("ICC_PROFILE") === 0 && opt.keepIcc) keep = true;
      if (s.m === 0xEE && id.indexOf("Adobe") === 0) keep = true;  // colour transform flag: needed to decode CMYK/YCCK correctly
      if (keep) parts.push(b.subarray(s.start, s.end));
      if (s.m === 0xD8 && opt.keepOri && orientation > 1 && orientation <= 8) parts.push(app1(buildExif({ ifd0: [[0x0112, 3, orientation]] }, false)));
    });
    return concat(parts);
  }

  // ---------- PNG ----------
  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const PNG_DROP = { tEXt: 1, zTXt: 1, iTXt: 1, eXIf: 1, tIME: 1 };
  function pngChunks(b) {
    if (!PNG_SIG.every((x, i) => b[i] === x)) throw new Error("Not a PNG file");
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [];
    let i = 8;
    while (i + 12 <= b.length) {
      const len = v.getUint32(i), type = ascii(b, i + 4, 4), end = i + 12 + len;
      if (end > b.length) throw new Error("Damaged PNG (chunk runs past the end)");
      out.push({ type, start: i, end, data: b.subarray(i + 8, i + 8 + len) });
      i = end;
      if (type === "IEND") break;
    }
    return { chunks: out, end: i };
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream === "undefined") return null;
    try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer()); }
    catch (e) { return null; }
  }
  async function inspectPng(b) {
    const { chunks, end } = pngChunks(b), blocks = [], meta = { fields: [], gps: null, orientation: 1 };
    const latin1 = new TextDecoder("latin1"), utf8 = new TextDecoder();
    for (const c of chunks) {
      const d = c.data, z = d.indexOf(0), key = z > 0 ? latin1.decode(d.subarray(0, z)) : "";
      if (c.type === "tEXt") { blocks.push(["Text: " + key, c.end - c.start]); meta.fields.push({ label: key || "Text", value: latin1.decode(d.subarray(z + 1)).slice(0, 300) }); }
      else if (c.type === "zTXt") { const t = await inflate(d.subarray(z + 2)); blocks.push(["Text: " + key, c.end - c.start]); meta.fields.push({ label: key || "Text", value: t ? latin1.decode(t).slice(0, 300) : "(compressed)" }); }
      else if (c.type === "iTXt") {
        const lang = d.indexOf(0, z + 3), tk = d.indexOf(0, lang + 1);
        const raw = d.subarray(tk + 1), t = d[z + 1] ? await inflate(raw) : raw;
        blocks.push(["Text: " + key, c.end - c.start]);
        meta.fields.push({ label: key || "Text", value: t ? utf8.decode(t).slice(0, 300) : "(compressed)" });
      } else if (c.type === "eXIf") {
        blocks.push(["EXIF", c.end - c.start]);
        try { const r = parseTiff(d); meta.fields = meta.fields.concat(r.fields); meta.gps = r.gps; meta.orientation = r.orientation; } catch (e) { meta.fields.push({ label: "EXIF", value: "present but damaged" }); }
      } else if (c.type === "tIME") { blocks.push(["Last-modified time", c.end - c.start]); if (d.length >= 7) meta.fields.push({ label: "Date modified", value: ((d[0] << 8) | d[1]) + "-" + String(d[2]).padStart(2, "0") + "-" + String(d[3]).padStart(2, "0") + " " + d[4] + ":" + String(d[5]).padStart(2, "0") }); }
      else if (c.type === "iCCP") blocks.push(["ICC color profile", c.end - c.start]);
    }
    if (end < b.length) blocks.push(["Data after the image", b.length - end]);
    return { type: "png", blocks, meta };
  }
  function cleanPng(b, opt) {
    const { chunks } = pngChunks(b);
    return concat([b.subarray(0, 8)].concat(chunks.filter(c => !PNG_DROP[c.type] && (opt.keepIcc || c.type !== "iCCP")).map(c => b.subarray(c.start, c.end))));
  }

  async function inspect(b) {
    if (b[0] === 0xFF && b[1] === 0xD8) return inspectJpeg(b);
    if (b[0] === 0x89 && b[1] === 0x50) return inspectPng(b);
    throw new Error("Only JPEG and PNG files are supported");
  }
  function clean(b, opt) { return b[0] === 0xFF ? cleanJpeg(b, opt) : cleanPng(b, opt); }

  // ---------- UI ----------
  let items = [];
  const opts = () => ({ keepIcc: $("#keepIcc").checked, keepOri: $("#keepOri").checked });
  const savedOpt = S3.store("exif") || {};
  if (savedOpt.keepIcc === false) $("#keepIcc").checked = false;
  if (savedOpt.keepOri === false) $("#keepOri").checked = false;
  ["keepIcc", "keepOri"].forEach(id => $("#" + id).addEventListener("change", () => { S3.store("exif", opts()); items.forEach(redo); }));

  function cleanName(n) { return n.replace(/(\.[^.]+)?$/, "-clean$1"); }
  function redo(it) {
    if (it.err) return render(it);
    try { it.clean = clean(it.bytes, opts()); } catch (e) { it.err = e.message; }
    render(it);
  }
  async function addFiles(files) {
    for (const f of files) {
      const it = { file: f, el: S3.h("section", { "class": "card" }) };
      $("#list").appendChild(it.el); items.push(it);
      try { it.bytes = new Uint8Array(await f.arrayBuffer()); it.info = await inspect(it.bytes); }
      catch (e) { it.err = e.message; }
      redo(it);
    }
    refresh();
    if (items.some(i => !i.err)) S3.done();
  }
  function refresh() { $("#zip").disabled = !items.some(i => i.clean && !i.err); $("#clear").disabled = !items.length; }
  function render(it) {
    const el = it.el; el.textContent = "";
    if (it.url) URL.revokeObjectURL(it.url);
    const head = S3.h("div", { "class": "ex-head" }, [S3.h("h2", { text: it.file.name, title: it.file.name })]);
    if (it.err) {
      head.appendChild(S3.h("span", { "class": "chip bad", text: it.err }));
      el.appendChild(head); return;
    }
    const m = it.info.meta, found = it.info.blocks.length > 0;
    it.url = URL.createObjectURL(new Blob([it.clean], { type: it.info.type === "png" ? "image/png" : "image/jpeg" }));
    head.appendChild(S3.h("span", { "class": "chip", text: S3.fmtBytes(it.bytes.length) + " → " + S3.fmtBytes(it.clean.length) }));
    head.appendChild(m.gps ? S3.h("span", { "class": "chip bad", text: "Reveals location" }) : found ? S3.h("span", { "class": "chip warn", text: "Has metadata" }) : S3.h("span", { "class": "chip ok", text: "Already clean" }));
    const right = S3.h("div", { "class": "stack" }, [head]);
    if (m.gps) {
      const coords = m.gps.lat.toFixed(6) + ", " + m.gps.lon.toFixed(6);
      const copy = S3.h("button", { "class": "btn small", text: "Copy coordinates" });
      copy.addEventListener("click", () => S3.copy(coords));
      right.appendChild(S3.h("div", { "class": "ex-gps", role: "alert" }, [
        "⚠ This photo reveals where it was taken:", S3.h("span", { "class": "mono", text: coords + (m.gps.alt != null ? " · " + Math.round(m.gps.alt) + " m" : "") }), copy
      ]));
    }
    if (m.fields.length) {
      right.appendChild(S3.h("div", { "class": "tbl-wrap" }, [S3.h("table", { "class": "tbl" }, [S3.h("tbody", {}, m.fields.map(f =>
        S3.h("tr", { "class": f.sensitive ? "ex-sens" : "" }, [S3.h("td", { text: f.label }), S3.h("td", { text: f.value })])))])]));
    }
    if (found) right.appendChild(S3.h("div", { "class": "ex-blocks" }, it.info.blocks.map(bk => {
      const kept = (/ICC/.test(bk[0]) && opts().keepIcc);
      return S3.h("span", { "class": "chip " + (kept ? "" : "accent"), text: bk[0] + " · " + S3.fmtBytes(bk[1]) + (kept ? " · kept" : " · removed") });
    })));
    else right.appendChild(S3.h("div", { "class": "ex-ok", text: "No hidden metadata found in this file." }));
    const dl = S3.h("button", { "class": "btn primary small", html: S3.icon("download") + " Download clean copy" });
    dl.addEventListener("click", () => { S3.download(new Blob([it.clean]), cleanName(it.file.name)); S3.done(); });
    const rm = S3.h("button", { "class": "btn ghost small", text: "Remove" });
    rm.addEventListener("click", () => { items = items.filter(x => x !== it); if (it.url) URL.revokeObjectURL(it.url); el.remove(); refresh(); });
    right.appendChild(S3.h("div", { "class": "row" }, [dl, rm]));
    el.appendChild(S3.h("div", { "class": "ex-card" }, [S3.h("img", { "class": "ex-thumb", src: it.url, alt: "" }), right]));
  }
  S3.drop($("#drop"), addFiles, { accept: ".jpg,.jpeg,.jfif,.png,image/jpeg,image/png", multiple: true });
  $("#clear").addEventListener("click", () => { items.forEach(it => it.url && URL.revokeObjectURL(it.url)); items = []; $("#list").textContent = ""; refresh(); });
  $("#zip").addEventListener("click", () => {
    const used = {}, files = [];
    items.filter(i => i.clean && !i.err).forEach(it => {
      let n = cleanName(it.file.name), k = 2; const base = n;
      while (used[n]) n = base.replace(/(\.[^.]+)?$/, "-" + (k++) + "$1");
      used[n] = 1; files.push({ name: n, data: it.clean });
    });
    S3.download(S3.zip(files), "clean-photos.zip"); S3.done();
  });

  // ---------- samples built in memory ----------
  function insertAfterSoi(jpeg, segs) { return concat([jpeg.subarray(0, 2)].concat(segs, [jpeg.subarray(2)])); }
  function seg(marker, payload) { const s = new Uint8Array(4 + payload.length); s[0] = 0xFF; s[1] = marker; s[2] = (payload.length + 2) >> 8; s[3] = (payload.length + 2) & 0xFF; s.set(payload, 4); return s; }
  function pngChunk(type, data) {
    const c = new Uint8Array(12 + data.length), v = new DataView(c.buffer);
    v.setUint32(0, data.length); for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8); v.setUint32(8 + data.length, S3.crc32(c.subarray(4, 8 + data.length)));
    return c;
  }
  function insertPngChunk(png, chunk) { return concat([png.subarray(0, 33), chunk, png.subarray(33)]); } // after IHDR (8 + 25)
  function scene(w, h) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"), g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#f7b267"); g.addColorStop(0.6, "#f4845f"); g.addColorStop(1, "#7a3e65");
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = "#2d1e2f";
    for (let i = 0; i < 9; i++) x.fillRect(w * (0.05 + i * 0.1), h * (0.45 + (i % 3) * 0.08), w * 0.07, h);
    return c;
  }
  const enc = new TextEncoder();
  const SAMPLE_EXIF = (le, ori) => buildExif({
    ifd0: [[0x010F, 2, "Google"], [0x0110, 2, "Pixel 9"], [0x0131, 2, "HDR+ 1.0"], [0x0112, 3, ori || 6], [0x0132, 2, "2026:10:21 18:42:05"]],
    exif: [[0x9003, 2, "2026:10:21 18:42:05"], [0x829D, 5, [[18, 10]]], [0x829A, 5, [[1, 250]]], [0x8827, 3, 64], [0x920A, 5, [[69, 10]]], [0xA431, 2, "PX9-48213377"]],
    gps: [[1, 2, "N"], [2, 5, [[31, 1], [57, 1], [1404, 100]]], [3, 2, "E"], [4, 5, [[35, 1], [54, 1], [3816, 100]]], [5, 1 + 2, 0], [6, 5, [[812, 1]]]]
  }, le);
  async function sampleJpeg(le, ori) {
    const base = new Uint8Array(await (await new Promise(r => scene(640, 420).toBlob(r, "image/jpeg", 0.85))).arrayBuffer());
    return insertAfterSoi(base, [app1(SAMPLE_EXIF(le, ori)), seg(0xFE, enc.encode("Holiday at the lake")), seg(0xED, enc.encode("Photoshop 3.0\0 8BIM fake IPTC block"))]);
  }
  async function samplePng() {
    const base = new Uint8Array(await (await new Promise(r => scene(400, 300).toBlob(r, "image/png"))).arrayBuffer());
    let p = insertPngChunk(base, pngChunk("tEXt", enc.encode("Author\0Jane Doe")));
    p = insertPngChunk(p, pngChunk("eXIf", SAMPLE_EXIF(false).subarray(6)));
    return p;
  }

  window.S3_DEMO = async function () {
    await addFiles([new File([await sampleJpeg(true, 1)], "IMG_20261021_184205.jpg", { type: "image/jpeg" }), new File([await samplePng()], "screenshot.png", { type: "image/png" })]);
  };

  window.S3_SELFTEST = async function () {
    const loads = async (bytes, type) => { const u = URL.createObjectURL(new Blob([bytes], { type })), im = new Image(); im.src = u; try { await im.decode(); return im.naturalWidth; } catch (e) { return 0; } finally { URL.revokeObjectURL(u); } };
    const has = (b, m) => jpegSegments(b).segs.some(s => s.m === m);
    // JPEG with little-endian EXIF (+GPS), a comment and an APP13 block.
    const j = await sampleJpeg(true), info = await inspect(j), mm = info.meta;
    const f = k => (mm.fields.filter(x => x.label === k)[0] || {}).value;
    const okParse = f("Camera make") === "Google" && f("Camera model") === "Pixel 9" && f("Date taken") === "2026:10:21 18:42:05" &&
      f("Aperture") === "f/1.8" && f("Exposure") === "1/250 s" && f("ISO") === "64" && f("Camera serial number") === "PX9-48213377" &&
      mm.orientation === 6 && Math.abs(mm.gps.lat - 31.95390) < 1e-4 && Math.abs(mm.gps.lon - 35.91060) < 1e-4 && mm.gps.alt === 812 && f("Comment") === "Holiday at the lake";
    // Strip everything: no APP1 / APP13 / COM left, scan data identical, smaller, still a valid image.
    const c0 = cleanJpeg(j, { keepIcc: true, keepOri: false });
    const sosA = jpegSegments(j).segs.filter(s => s.m === 0xDA)[0], sosB = jpegSegments(c0).segs.filter(s => s.m === 0xDA)[0];
    const sameScan = j.subarray(sosA.start).length === c0.subarray(sosB.start).length && j.subarray(sosA.start).every((x, i) => x === c0[sosB.start + i]);
    const okStrip = !has(c0, 0xE1) && !has(c0, 0xED) && !has(c0, 0xFE) && sameScan && c0.length < j.length && (await loads(c0, "image/jpeg")) === 640 &&
      (await inspect(c0)).blocks.every(bk => /ICC/.test(bk[0])); // the canvas encoder adds an ICC profile, which is kept by choice
    // Keep rotation: exactly one tiny APP1 holding only Orientation=6, no GPS.
    const c1 = cleanJpeg(j, { keepIcc: true, keepOri: true }), ap = jpegSegments(c1).segs.filter(s => s.m === 0xE1);
    const r1 = parseTiff(c1.subarray(ap[0].start + 10, ap[0].end));
    const okOri = ap.length === 1 && ap[0].end - ap[0].start < 40 && r1.orientation === 6 && !r1.gps && r1.fields.length === 0;
    // Trailing data after EOI (embedded preview) is dropped.
    const okTrail = cleanJpeg(concat([c0, new Uint8Array([0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9])]), { keepIcc: true, keepOri: false }).length === c0.length;
    // PNG: big-endian eXIf + tEXt are read, then removed; result still decodes.
    const p = await samplePng(), pi = await inspect(p), pc = cleanPng(p, { keepIcc: true });
    const types = pngChunks(pc).chunks.map(c => c.type);
    const okPng = pi.meta.gps && Math.abs(pi.meta.gps.lat - 31.9539) < 1e-4 && pi.meta.fields.some(x => x.label === "Author" && x.value === "Jane Doe") &&
      types.indexOf("tEXt") < 0 && types.indexOf("eXIf") < 0 && types[0] === "IHDR" && types[types.length - 1] === "IEND" && (await loads(pc, "image/png")) === 400;
    // Garbage is rejected, not crashed on.
    let okBad = false; try { await inspect(new Uint8Array([1, 2, 3, 4])); } catch (e) { okBad = true; }
    let okTrunc = false; try { jpegSegments(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x40, 0x00, 1, 2])); } catch (e) { okTrunc = true; }
    return (okParse && okStrip && okOri && okTrail && okPng && okBad && okTrunc) || { okParse, okStrip, okOri, okTrail, okPng, okBad, okTrunc, fields: mm.fields, gps: mm.gps };
  };
})();
