/**
 * Build dist/ from src/swarm.js.
 *
 *   dist/swarm.min.js     the whole library, every body
 *   dist/<body>.min.js        one body: the core, its mode, and nothing else
 *
 * Source sections are marked with the banner comments already in the file, so
 * a new mode needs no change here. Modes must depend only on the core: the
 * build fails if one reaches into another mode's section.
 *
 *   node tools/build.js
 */
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'swarm.js');
const DIST = path.join(ROOT, 'dist');
const BANNER = /^ {2}\/\* =+ ([\w+ ]+) \*\/$/;
const DRIVER = 'registry + driver';

/* -------------------------------------------------- cut the source into parts */
function readSource() {
  const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);   // CRLF checkouts included
  const marks = [];
  lines.forEach((l, i) => { const m = BANNER.exec(l); if (m) marks.push([i, m[1].trim()]); });
  if (!marks.length) throw new Error('no section banners found in src/swarm.js');

  const join = a => a.join('\n') + '\n';
  const head = join(lines.slice(0, marks[0][0]));             // licence line, IIFE opener, core helpers
  const sections = {};
  marks.forEach(([start, name], j) => {
    const end = j + 1 < marks.length ? marks[j + 1][0] : lines.length;
    sections[name] = join(lines.slice(start, end));
  });
  const driver = sections[DRIVER];
  if (!driver) throw new Error(`no "${DRIVER}" section`);
  delete sections[DRIVER];
  return { head, modes: sections, driver };
}

// top-level `const`/`let`/`function` names a chunk declares
const declared = chunk => [...chunk.matchAll(/^ {2}(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
const words = chunk => new Set([...chunk.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]));

function assertModesAreIndependent(modes) {
  const owner = {};
  for (const [name, body] of Object.entries(modes)) for (const d of declared(body)) owner[d] = name;
  const problems = [];
  for (const [name, body] of Object.entries(modes)) {
    for (const w of words(body)) if (owner[w] && owner[w] !== name) problems.push(`  ${name} uses ${w}, declared in ${owner[w]}`);
  }
  if (problems.length) {
    throw new Error('modes must depend only on the core, but:\n' + problems.join('\n') +
      '\nMove the shared helper into the core section at the top of src/swarm.js.');
  }
}

/* -------------------------------------------------- trim the driver to one body */
// The driver closes the IIFE, so a per-body file keeps all of it and only narrows
// the three tables: MODES, BODIES, GROUPS. Everything else (mount, exports) is shared.
function driverForBody(driver, bodyName, modeName, bodies) {
  const aliasFor = Object.entries(bodies).filter(([, v]) => v === bodyName).map(([k]) => k);
  const keep = new Set([bodyName, ...aliasFor]);

  let out = driver;

  // MODES: keep the one entry
  out = out.replace(/ {2}const MODES = \{[\s\S]*?\n {2}\};\n/, (block) => {
    const line = block.split(/\r?\n/).find(l => new RegExp(`^\\s{4}${modeName}:`).test(l));
    if (!line) throw new Error(`mode ${modeName} not found in the MODES table`);
    return `  const MODES = {\n${line.replace(/,\s*$/, '')}\n  };\n`;
  });

  // BODIES: keep the one entry, dropping its trailing comma
  out = out.replace(/ {2}const BODIES = \{[\s\S]*?\n {2}\};\n/, (block) => {
    const lines = block.split(/\r?\n/);
    const start = lines.findIndex(l => new RegExp(`^\\s{4}'${bodyName.replace(/[-]/g, '\\-')}':`).test(l));
    if (start < 0) throw new Error(`body ${bodyName} not found in the BODIES table`);
    let end = start;                                    // a body may span several lines (jupiter-moons)
    while (end + 1 < lines.length && !/^\s{4}(?:\/\/|')/.test(lines[end + 1]) && !/^ {2}\};/.test(lines[end + 1])) end++;
    const entry = lines.slice(start, end + 1).join('\n').replace(/,\s*$/, '');
    return `  const BODIES = {\n${entry}\n  };\n`;
  });

  // drop every alias assignment from the source, then re-add just this body's
  out = out.replace(/^ {2}BODIES(?:\.\w+|\['[\w-]+'\]) = BODIES(?:\.\w+|\['[\w-]+'\]);.*\r?\n/gm, '');
  const aliasLines = aliasFor.map(a => `  BODIES['${a}'] = BODIES['${bodyName}'];`).join('\n');

  // GROUPS: one family, one member
  out = out.replace(/ {2}const GROUPS = \{[\s\S]*?\n {2}\};\n/, (block) => {
    const fam = block.split(/\r?\n/).find(l => l.includes(`'${bodyName}'`));
    const label = fam ? (fam.match(/^\s*'([^']+)':/) || [, 'Bodies'])[1] : 'Bodies';
    return `  const GROUPS = { '${label}': ['${bodyName}'] };\n`;
  });

  return out.replace(/ {2}const GROUPS = /, `${aliasLines}${aliasLines ? '\n' : ''}  const GROUPS = `);
}

/* -------------------------------------------------- go */
(async () => {
  const { head, modes, driver } = readSource();
  assertModesAreIndependent(modes);

  const full = fs.readFileSync(SRC, 'utf8');
  const version = (full.match(/version: '([^']+)'/) || [, '0.0.0'])[1];
  const licence = `/*! swarm ${version} | MIT | github.com/TonkaTuff/swarm */\n`;

  // the body table, read straight out of the source so this never drifts
  const Swarm = require(SRC);
  const bodies = {};
  for (const [name, b] of Object.entries(Swarm.BODIES)) bodies[name] = b;
  const canonical = new Set(Object.values(Swarm.GROUPS).flat());
  const aliases = {};                                   // alias -> canonical name
  for (const [name, b] of Object.entries(bodies)) {
    if (canonical.has(name)) continue;
    const hit = [...canonical].find(c => bodies[c] === b);
    if (hit) aliases[name] = hit;
  }

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const squeeze = async (code, name) => {
    const r = await minify(code, {
      compress: { passes: 2 },
      mangle: true,
      format: { comments: /^!/ },
    });
    if (r.error) throw r.error;
    const out = licence + r.code + '\n';
    fs.writeFileSync(path.join(DIST, name), out);
    return Buffer.byteLength(out);
  };

  const rows = [];
  rows.push(['swarm.min.js', `all ${canonical.size}`, await squeeze(full, 'swarm.min.js')]);

  for (const name of canonical) {
    const mode = bodies[name].mode;
    if (!modes[mode]) throw new Error(`body ${name} wants mode ${mode}, which has no section`);
    const mine = Object.entries(aliases).filter(([, c]) => c === name).map(([a]) => a);
    const code = head + modes[mode] + driverForBody(driver, name, mode, aliases);
    rows.push([`${name}.min.js`, mode + (mine.length ? ` (+${mine.join(', ')})` : ''), await squeeze(code, `${name}.min.js`)]);
  }

  const zlib = require('zlib');
  const gz = f => zlib.gzipSync(fs.readFileSync(path.join(DIST, f)), { level: 9 }).length;
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`swarm ${version} -> dist/  (${rows.length} files)\n`);
  console.log(`${pad('file', 26)}${pad('mode', 22)}${'min'.padStart(8)}${'gzip'.padStart(8)}`);
  for (const [f, mode, size] of rows) console.log(`${pad(f, 26)}${pad(mode, 22)}${String(size).padStart(8)}${String(gz(f)).padStart(8)}`);
})().catch(e => { console.error('\nbuild failed:', e.message); process.exit(1); });
