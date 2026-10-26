// A small, dependency-free .xlsx reader -- just enough for the two scorecard
// workbooks: sheet names, and each cell's value (number / string / boolean).
// No styles, no formatting, no writing.
//
// Why not a library: the first cloud run used ExcelJS and stalled indefinitely
// inside the parse on the real HVAC Sales workbook (the sheets are only ~100
// rows, so it wasn't size -- something in the file's structure). An .xlsx is a
// zip of XML files, and the data we need lives in three of them, so reading it
// directly is shorter than debugging a library we can't run locally, and this
// module can be tested in any JavaScript engine (it takes the inflate
// function as a parameter -- zlib in Node, DecompressionStream in a browser).
//
// readWorkbook(buffer, inflateRaw) -> { sheets: [{ name, rows: Map<rowNumber, Map<colNumber, value>> }] }
//   buffer      Uint8Array / Buffer holding the .xlsx
//   inflateRaw  async (Uint8Array) => Uint8Array   (raw DEFLATE, no zlib header)
// A cell's value is a number, a string (shared/inline/formula-string), a
// boolean, or an error string like "#N/A". Empty cells are simply absent.

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

async function readZip(bytes, inflateRaw) {
  // End-of-central-directory record: scan back for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip/xlsx file (no end-of-central-directory record)");
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const utf8 = new TextDecoder("utf-8");
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = u16(bytes, p + 10);
    const compSize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`"${name}" not found in the workbook`);
      const lo = e.localOffset;
      if (u32(bytes, lo) !== 0x04034b50) throw new Error("corrupt zip local header");
      const start = lo + 30 + u16(bytes, lo + 26) + u16(bytes, lo + 28);
      const data = bytes.subarray(start, start + e.compSize);
      const raw = e.method === 0 ? data : e.method === 8 ? await inflateRaw(data) : null;
      if (!raw) throw new Error(`unsupported zip compression method ${e.method} for "${name}"`);
      return utf8.decode(raw);
    },
  };
}

function decodeEntities(s) {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

// All visible text in a <si> / <is> block: every <t>, except phonetic runs.
function textOf(xml) {
  const cleaned = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of cleaned.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeEntities(out);
}

function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

async function readWorkbook(buffer, inflateRaw) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const zip = await readZip(bytes, inflateRaw);

  const workbookXml = await zip.text("xl/workbook.xml");
  if (/<workbookPr[^>]*date1904="(1|true)"/.test(workbookXml)) throw new Error("1904 date system is not supported");

  const relsXml = await zip.text("xl/_rels/workbook.xml.rels");
  const targetById = {};
  for (const m of relsXml.matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) targetById[a.Id] = a.Target;
  }

  const shared = [];
  if (zip.has("xl/sharedStrings.xml")) {
    const sst = await zip.text("xl/sharedStrings.xml");
    for (const m of sst.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)) shared.push(m[1] ? textOf(m[1]) : "");
  }

  const sheets = [];
  for (const m of workbookXml.matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    const target = targetById[a["r:id"]];
    if (!target) continue;
    const file = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    sheets.push({ name: a.name, rows: parseSheet(await zip.text(file), shared) });
  }
  return { sheets };
}

function parseSheet(xml, shared) {
  const rows = new Map();
  let nextRow = 1;
  for (const rm of xml.matchAll(/<row(?:\s([^>]*?))?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNum = Number((attrs(rm[1] || "").r)) || nextRow;
    nextRow = rowNum + 1;
    if (!rm[2]) continue;
    const cells = new Map();
    let nextCol = 1;
    for (const cm of rm[2].matchAll(/<c(?:\s([^>]*?))?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1] || "");
      let col = nextCol;
      if (a.r) {
        const letters = /^([A-Z]+)/.exec(a.r);
        if (letters) col = colNumber(letters[1]);
      }
      nextCol = col + 1;
      if (!cm[2]) continue;
      const body = cm[2];
      const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
      let value = null;
      if (a.t === "inlineStr") {
        const im = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(body);
        value = im ? textOf(im[1]) : "";
      } else if (vm) {
        const raw = vm[1];
        if (a.t === "s") value = shared[Number(raw)] ?? "";
        else if (a.t === "str") value = decodeEntities(raw);
        else if (a.t === "b") value = raw === "1";
        else if (a.t === "e") value = decodeEntities(raw);
        else {
          const n = Number(raw);
          value = Number.isFinite(n) ? n : decodeEntities(raw);
        }
      }
      if (value !== null && value !== "") cells.set(col, value);
    }
    if (cells.size) rows.set(rowNum, cells);
  }
  return rows;
}

module.exports = { readWorkbook };
