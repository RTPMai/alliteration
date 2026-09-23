// PUT IN: test/app-imports.test.cjs
/**
 * An app file cannot use a constant from its own lib folder without importing
 * it.
 *
 * WHY THIS EXISTS. Twice in one week, an edit to apps/concontrol.js added a use
 * of a constant and did not add it to the import list. Both times the whole
 * suite stayed green, both times the file parsed, and both times the failure
 * was silent in exactly the worst way: the ReferenceError happens while
 * rendering, so the click does nothing at all. No error on screen, no broken
 * page, just a button that has stopped working. The first one made the settings
 * refill button dead. The second made every sponsor card unclickable.
 *
 * `node --check` does not catch this: the syntax is fine. Tests of the lib
 * functions do not catch it: the lib is fine. Only the browser catches it, and
 * only if somebody clicks the right thing.
 *
 * SCOPE, KEPT DELIBERATELY NARROW. Uppercase constants only, and only from the
 * app's own lib/<id>/ folder. A broader version of this check, run against
 * every export in lib/, produces eighty findings that are almost all words like
 * `keys`, `money` and `quotes` appearing as local variables or object
 * properties. A check that cries wolf eighty times is a check somebody deletes.
 * This one is quiet and catches the thing that actually broke.
 *
 * Comments are stripped before matching, because a constant NAMED in a comment
 * is documentation, not a use.
 */

const t = require('./harness.cjs');
const fs = require('fs');
const path = require('path');

/**
 * Strip comments before matching. Three kinds, because these files are markup
 * and JavaScript in the same string: JS block comments, JS line comments, and
 * HTML comments inside the template literals.
 */
function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function exportedConstants(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.js')) continue;
    const file = path.join(dir, entry);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]{2,})\s*=/g)) {
      out.set(m[1], file);
    }
  }
  return out;
}

function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

t.test('every app imports the constants it uses from its own lib folder', () => {
  const apps = fs.readdirSync('apps').filter((f) => f.endsWith('.js'));
  t.assert(apps.length > 5, 'found the app files');

  const problems = [];

  for (const file of apps) {
    const id = file.replace(/\.js$/, '');
    const src = fs.readFileSync(path.join('apps', file), 'utf8');
    const imported = importedNames(src);

    // A constant the app declares itself is not a missing import.
    const declared = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})/g)) declared.add(m[1]);

    const body = codeOnly(src.replace(/import\s*\{[^}]*\}\s*from[^;]*;/g, ' '));

    for (const [name, from] of exportedConstants(`lib/${id}`)) {
      if (imported.has(name) || declared.has(name)) continue;
      const used = new RegExp('(?<![\\w$.])' + name + '(?![\\w$])').test(body);
      if (used) problems.push(`apps/${file} uses ${name} from ${from} without importing it`);
    }
  }

  t.equal(problems.join('; '), '', 'no app uses a constant it has not imported');
});

/**
 * The same class of failure, one level down: an app that imports a name its lib
 * does not export. That fails at load rather than at click, so it is louder,
 * but it is the same edit that causes it.
 */
t.test('no app imports a name its own lib does not export', () => {
  const problems = [];

  for (const file of fs.readdirSync('apps').filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join('apps', file), 'utf8');

    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/(lib\/[^'"]+)['"]/g)) {
      const target = m[2];
      if (!fs.existsSync(target)) { problems.push(`apps/${file} imports from ${target}, which does not exist`); continue; }
      const libSrc = fs.readFileSync(target, 'utf8');
      const exported = new Set();
      for (const e of libSrc.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(e[1]);
      for (const e of libSrc.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of e[1].split(',')) {
          const n = part.trim().split(/\s+as\s+/).pop().trim();
          if (n) exported.add(n);
        }
      }
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!exported.has(name)) problems.push(`apps/${file} imports ${name} from ${target}, which does not export it`);
      }
    }
  }

  t.equal(problems.join('; '), '', 'every imported name is really exported');
});

/**
 * Same two checks for the files an app keeps in a folder of its own
 * (apps/concontrol/social.js, apps/marketmachine/*.js). Those import from
 * ../../lib/, one level further up, and the scans above only read apps/*.js,
 * so a screen split out to stay under the 100KB upload line would otherwise
 * be the one screen nothing checks.
 */
t.test('app sub-modules import what they use, and only what exists', () => {
  const problems = [];
  for (const dirName of fs.readdirSync('apps')) {
    const dir = path.join('apps', dirName);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const where = `apps/${dirName}/${file}`;
      const imported = importedNames(src);
      const declared = new Set();
      for (const m of src.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})/g)) declared.add(m[1]);
      const body = codeOnly(src.replace(/import\s*\{[^}]*\}\s*from[^;]*;/g, ' ').replace(/import\s+\w+\s*,\s*\{[^}]*\}\s*from[^;]*;/g, ' '));

      for (const [name, from] of exportedConstants(`lib/${dirName}`)) {
        if (imported.has(name) || declared.has(name)) continue;
        if (new RegExp('(?<![\\w$.])' + name + '(?![\\w$])').test(body)) {
          problems.push(`${where} uses ${name} from ${from} without importing it`);
        }
      }

      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/\.\.\/(lib\/[^'"]+)['"]/g)) {
        const target = m[2];
        if (!fs.existsSync(target)) { problems.push(`${where} imports from ${target}, which does not exist`); continue; }
        const libSrc = fs.readFileSync(target, 'utf8');
        const exported = new Set();
        for (const e of libSrc.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(e[1]);
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name && !exported.has(name)) problems.push(`${where} imports ${name} from ${target}, which does not export it`);
        }
      }
    }
  }
  t.equal(problems.join('; '), '', 'every folder module imports what it uses and nothing that is missing');
});

process.exit(t.report());
