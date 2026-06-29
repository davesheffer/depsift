#!/usr/bin/env node
// depit — "should i install <pkg>?"
// Resolves a package's (or your whole project's) dependency tree straight from
// the npm registry — no install, no node_modules — and prints a scorecard:
// how many packages you'd really add, how much disk, how many maintainers you'd
// be trusting, how stale they are, and the literal install scripts that run
// code on your machine. Zero runtime dependencies.

import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const REGISTRY = process.env.DEPIT_REGISTRY || "https://registry.npmjs.org";
// Full packument — carries maintainers, publish times, and scripts, which the
// abbreviated form drops. One request per unique package covers every metric.
const ACCEPT = "application/json";
const CONCURRENCY = 12;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const STALE_MS = 2 * YEAR_MS; // last publish older than this = stale

// ===================== semver (zero-dep, npm-accurate subset) =====================
function svParse(v) {
  if (typeof v !== "string") return null;
  const m = v
    .trim()
    .replace(/^[v=]+/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}
function cmpPre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function svCmp(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return cmpPre(a.pre, b.pre);
}
function comparators(part) {
  part = part.trim();
  if (part === "" || part === "*" || part === "x" || part === "X")
    return [{ op: ">=", v: svParse("0.0.0") }];
  const out = [];
  for (const t of part.split(/\s+/)) {
    const opm = t.match(/^(>=|<=|>|<|=|\^|~)?\s*(.*)$/);
    let op = opm[1] || "=";
    let ver = opm[2].replace(/^[v=]+/, "");
    const xm = ver.match(/^(\d+|\*|x|X)?(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?(?:-([0-9A-Za-z.-]+))?$/) || [];
    const isX = (s) => s === undefined || s === "" || s === "*" || s === "x" || s === "X";
    if (op === "^" || op === "~") {
      const major = +xm[1] || 0;
      const minor = isX(xm[2]) ? 0 : +xm[2];
      const patch = isX(xm[3]) ? 0 : +xm[3];
      const pre = xm[4] ? xm[4].split(".") : [];
      const lower = { major, minor, patch, pre };
      let upper;
      if (op === "~") {
        upper = isX(xm[2])
          ? { major: major + 1, minor: 0, patch: 0, pre: [] }
          : { major, minor: minor + 1, patch: 0, pre: [] };
      } else if (major > 0 || isX(xm[2])) upper = { major: major + 1, minor: 0, patch: 0, pre: [] };
      else if (minor > 0 || isX(xm[3])) upper = { major: 0, minor: minor + 1, patch: 0, pre: [] };
      else upper = { major: 0, minor: 0, patch: patch + 1, pre: [] };
      out.push({ op: ">=", v: lower }, { op: "<", v: upper });
      continue;
    }
    if (isX(xm[1])) { out.push({ op: ">=", v: svParse("0.0.0") }); continue; }
    if (isX(xm[2])) {
      const M = +xm[1];
      out.push({ op: ">=", v: { major: M, minor: 0, patch: 0, pre: [] } });
      out.push({ op: "<", v: { major: M + 1, minor: 0, patch: 0, pre: [] } });
      continue;
    }
    if (isX(xm[3])) {
      const M = +xm[1], mn = +xm[2];
      out.push({ op: ">=", v: { major: M, minor: mn, patch: 0, pre: [] } });
      out.push({ op: "<", v: { major: M, minor: mn + 1, patch: 0, pre: [] } });
      continue;
    }
    const pv = svParse(ver);
    if (!pv) return null;
    out.push({ op, v: pv });
  }
  return out;
}
function satisfiesPart(version, part) {
  const hy = part.match(/^\s*(.+?)\s+-\s+(.+?)\s*$/);
  let comps;
  if (hy) {
    const loC = comparators(hy[1]);
    const lo = svParse(hy[1]) || (loC && loC[0].v);
    const hiC = comparators(hy[2]);
    const hi = svParse(hy[2]) || (hiC && hiC[hiC.length - 1].v);
    if (!lo || !hi) return false;
    comps = [{ op: ">=", v: lo }, { op: "<=", v: hi }];
  } else comps = comparators(part);
  if (!comps) return false;
  if (version.pre.length) {
    const allow = comps.some(
      (c) => c.v.pre.length && c.v.major === version.major && c.v.minor === version.minor && c.v.patch === version.patch
    );
    if (!allow) return false;
  }
  for (const c of comps) {
    const r = svCmp(version, c.v);
    if (c.op === ">=" && !(r >= 0)) return false;
    if (c.op === ">" && !(r > 0)) return false;
    if (c.op === "<=" && !(r <= 0)) return false;
    if (c.op === "<" && !(r < 0)) return false;
    if (c.op === "=" && r !== 0) return false;
  }
  return true;
}
function satisfies(version, range) {
  const v = typeof version === "string" ? svParse(version) : version;
  if (!v) return false;
  if (range == null || range === "" || range === "*" || range === "latest") return v.pre.length === 0;
  return String(range).split("||").some((part) => satisfiesPart(v, part));
}
function maxSatisfying(versions, range) {
  let best = null, bestP = null;
  for (const ver of versions) {
    const p = svParse(ver);
    if (!p || !satisfies(p, range)) continue;
    if (!bestP || svCmp(p, bestP) > 0) { best = ver; bestP = p; }
  }
  return best;
}

// ===================== tiny ANSI (no deps) =====================
const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const bold = c("1"), dim = c("2"), red = c("31"), green = c("32"),
  yellow = c("33"), cyan = c("36"), gray = c("90");

// ===================== helpers =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArg(spec) {
  let name = spec, version = "";
  const at = spec.lastIndexOf("@");
  if (at > 0) { name = spec.slice(0, at); version = spec.slice(at + 1); }
  return { name, version };
}
function bytes(n) {
  if (!n) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function age(iso) {
  if (!iso) return "?";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "?";
  const y = ms / YEAR_MS;
  if (y >= 1) return `${y.toFixed(y < 10 ? 1 : 0)}y`;
  const mo = ms / (30 * 24 * 60 * 60 * 1000);
  if (mo >= 1) return `${Math.round(mo)}mo`;
  const w = ms / (7 * 24 * 60 * 60 * 1000);
  if (w >= 1) return `${Math.round(w)}w`;
  return "days";
}

const INSTALL_PHASES = ["preinstall", "install", "postinstall"];
function installCommands(meta) {
  const s = meta.scripts || {};
  return INSTALL_PHASES.filter((p) => s[p]).map((p) => ({ phase: p, cmd: s[p] }));
}

// Heuristic scan of an install command for behavior you rarely want running
// unattended on your machine. Conservative patterns, labelled by kind.
const DANGER = [
  [/\b(curl|wget|fetch)\b|https?:\/\//i, "network"],
  [/\|\s*(sh|bash|zsh|node|python)\b/i, "pipe-to-shell"],
  [/\b(base64|atob|xxd)\b/i, "obfuscation"],
  [/\beval\b|node\s+-e\b|new Function/i, "dynamic-exec"],
  [/process\.env|printenv|[$]\{?[A-Z_]+\}?.*(curl|http|nc )/i, "reads-env"],
  [/\brm\s+-rf\b|>\s*\/dev\/|mkfifo|nc\s+-/i, "destructive/recon"],
];
function scanDanger(cmd) {
  const hits = [];
  for (const [re, label] of DANGER) if (re.test(cmd)) hits.push(label);
  return hits;
}

async function fetchPackument(name, attempt = 0) {
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { accept: ACCEPT }, signal: ac.signal });
    if (res.status === 404) throw new Error(`package not found: ${name}`);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(300 * (attempt + 1) * (attempt + 1));
      return fetchPackument(name, attempt + 1);
    }
    if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
    return await res.json();
  } catch (e) {
    if ((e.name === "AbortError" || e.code === "ECONNRESET") && attempt < 3) {
      await sleep(300 * (attempt + 1));
      return fetchPackument(name, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Query npm's free bulk advisory endpoint (the same data `npm audit` uses — no
// Snyk, no account, no AI) and attach matching CVEs to each resolved record.
// Authoritative and deterministic: real vulnerable-version ranges, not guesses.
async function fetchAdvisories(records) {
  const payload = {};
  for (const r of records) (payload[r.name] ||= new Set()).add(r.version);
  for (const k of Object.keys(payload)) payload[k] = [...payload[k]];
  let data = {};
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const res = await fetch(`${REGISTRY}/-/npm/v1/security/advisories/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (res.ok) data = await res.json();
  } catch {
    /* advisory lookup is best-effort; the card still renders without it */
  }
  for (const r of records) {
    const advs = data[r.name] || [];
    r.vulns = advs
      .filter((a) => satisfies(r.version, a.vulnerable_versions))
      .map((a) => ({ severity: a.severity, title: a.title, url: a.url }));
  }
  return Object.keys(data).length > 0;
}

// pick the concrete version a spec resolves to, the way npm would: exact match,
// dist-tag, or highest version satisfying a range. Non-semver specs
// (git/url/workspace/file) fall back to latest.
function resolveSpec(pkg, spec) {
  const versions = Object.keys(pkg.versions || {});
  const tags = pkg["dist-tags"] || {};
  if (!spec || spec === "latest" || spec === "*")
    return tags.latest || maxSatisfying(versions, "*") || versions[versions.length - 1];
  if (pkg.versions && pkg.versions[spec]) return spec;
  if (tags[spec]) return tags[spec];
  const ms = maxSatisfying(versions, spec);
  return ms || tags.latest || versions[versions.length - 1];
}

// ===================== resolver (version-accurate, deduped by name@version) =====================
async function resolveSeeds(seeds) {
  const packs = new Map(); // name -> Promise<packument>
  const getPack = (name) => {
    if (!packs.has(name)) packs.set(name, fetchPackument(name));
    return packs.get(name);
  };
  const seen = new Map(); // "name@version" -> record (null while reserved)
  const errors = [];
  let frontier = seeds.slice();

  while (frontier.length) {
    const batch = frontier.splice(0, CONCURRENCY);
    const next = [];
    await Promise.all(
      batch.map(async (req) => {
        let pkg;
        try {
          pkg = await getPack(req.name);
        } catch (e) {
          errors.push(`${req.name}: ${e.message}`);
          return;
        }
        const v = resolveSpec(pkg, req.spec);
        if (!v) { errors.push(`${req.name}: no version for ${req.spec}`); return; }
        const key = `${req.name}@${v}`;
        // no await between this check and the reserve below → race-free
        if (seen.has(key)) return;
        seen.set(key, null);
        const meta = (pkg.versions || {})[v] || {};
        seen.set(key, {
          key,
          name: req.name,
          version: v,
          depth: req.depth,
          size: (meta.dist && meta.dist.unpackedSize) || 0,
          installCmds: installCommands(meta),
          installScript: installCommands(meta).length > 0,
          deprecated: !!meta.deprecated,
          maintainers: (pkg.maintainers || meta.maintainers || [])
            .map((m) => (typeof m === "string" ? m : m && m.name))
            .filter(Boolean),
          publishedAt: (pkg.time && pkg.time[v]) || null,
        });
        for (const [dn, dr] of Object.entries(meta.dependencies || {}))
          next.push({ name: dn, spec: dr, depth: req.depth + 1 });
      })
    );
    frontier.push(...next);
  }

  return { records: [...seen.values()].filter(Boolean), errors };
}

// ===================== scoring =====================
function score(records, { excludeKey = null, asked = 1 } = {}) {
  const counted = excludeKey ? records.filter((r) => r.key !== excludeKey) : records;
  const total = counted.length;
  const size = records.reduce((a, r) => a + r.size, 0);
  const installScripts = records.filter((r) => r.installScript);
  const deprecated = records.filter((r) => r.deprecated);
  const direct = records.filter((r) => r.depth === 1).length;
  const names = new Set(records.map((r) => r.name)).size;

  for (const r of installScripts) {
    const labels = new Set();
    for (const cmd of r.installCmds) for (const l of scanDanger(cmd.cmd)) labels.add(l);
    r.danger = [...labels];
  }
  const dangerous = installScripts.filter((r) => r.danger.length);

  const maintainerSet = new Set();
  for (const r of records) for (const m of r.maintainers) maintainerSet.add(m);
  const maintainers = maintainerSet.size;

  const dated = records.filter((r) => r.publishedAt);
  const now = Date.now();
  let oldest = null;
  for (const r of dated)
    if (!oldest || Date.parse(r.publishedAt) < Date.parse(oldest.publishedAt)) oldest = r;
  const stale = dated.filter((r) => now - Date.parse(r.publishedAt) > STALE_MS);

  // known CVEs across the resolved tree (from npm's advisory data)
  const vulnList = records.flatMap((r) =>
    (r.vulns || []).map((v) => ({ ...v, pkg: r.name, version: r.version }))
  );
  const sevCount = (sv) => vulnList.filter((v) => v.severity === sv).length;
  const vulns = {
    critical: sevCount("critical"),
    high: sevCount("high"),
    moderate: sevCount("moderate"),
    low: sevCount("low"),
    total: vulnList.length,
    list: vulnList,
  };

  // Calibration: F is reserved for genuine danger — a known critical CVE or an
  // install script that phones home / evals — not merely a big tree. Size,
  // count, and staleness are bloat signals that only nudge the grade.
  let pts = 100;
  pts -= Math.min(50, vulns.critical * 25); // a critical CVE alone can force F
  pts -= Math.min(36, vulns.high * 12);
  pts -= Math.min(16, vulns.moderate * 4);
  pts -= Math.min(8, vulns.low * 1);
  pts -= Math.min(20, installScripts.length * 5); // benign native build = mild
  const dangerPenalty = dangerous.reduce((a, r) => a + Math.min(40, r.danger.length * 15), 0);
  pts -= Math.min(60, dangerPenalty); // the real threat — can sink to F alone
  pts -= Math.min(20, deprecated.length * 5);
  pts -= Math.min(12, stale.length * 2);
  if (size > 100e6) pts -= 12;
  else if (size > 30e6) pts -= 7;
  else if (size > 10e6) pts -= 3;
  if (total > 1000) pts -= 15;
  else if (total > 400) pts -= 8;
  else if (total > 150) pts -= 4;
  else if (total > 50) pts -= 2;
  pts = Math.max(0, pts);

  const grade = pts >= 90 ? "A" : pts >= 80 ? "B" : pts >= 70 ? "C" : pts >= 55 ? "D" : "F";
  const oldestYears = oldest ? (now - Date.parse(oldest.publishedAt)) / YEAR_MS : 0;

  let quip;
  if (vulns.critical || vulns.high) {
    const n = vulns.critical + vulns.high;
    const detail = [vulns.critical && vulns.critical + " critical", vulns.high && vulns.high + " high"].filter(Boolean).join(", ");
    quip = `${n} serious known vulnerabilit${n > 1 ? "ies" : "y"} in the tree (${detail}) — patch or avoid.`;
  }
  else if (dangerous.length)
    quip = `an install script is flagged for ${dangerous[0].danger.join(", ")} — read the command above before you trust it.`;
  else if (installScripts.length)
    quip = `${installScripts.length} package${installScripts.length > 1 ? "s" : ""} run${installScripts.length > 1 ? "" : "s"} code on your machine at install — review before trusting.`;
  else if (deprecated.length) quip = "ships deprecated packages — may rot soon.";
  else if (oldestYears >= 4 && pts < 88) quip = "some deps haven't shipped in years — may be unmaintained.";
  else if (total > 200) quip = "heavy. one import, a whole neighborhood moves in.";
  else if (total === 0) quip = "zero dependencies. install with confidence.";
  else if (total <= 10) quip = "lean. safe to add.";
  else quip = "fine — typical for its size.";

  return { total, names, size, installScripts, deprecated, direct, dangerous, vulns, maintainers, oldest, stale, asked, grade, quip, pts };
}

// ===================== render =====================
function render({ subject, version, project }, s, errCount) {
  const line = gray("  " + "─".repeat(46));
  const gradeColor = s.grade === "A" || s.grade === "B" ? green : s.grade === "C" ? yellow : red;
  const out = [""];
  if (project)
    out.push(`  ${dim("should i trust")} ${bold(cyan(subject))}${dim("'s dependencies ?")}`);
  else
    out.push(`  ${dim("should i install")} ${bold(cyan(subject))}${version ? dim("@" + version) : ""} ${dim("?")}`);
  out.push("");

  const dupNote = s.names < s.total ? dim(` · ${s.names} unique names`) : "";
  out.push(
    `  📦 ${bold(String(s.total))} packages ${project ? "in the tree" : "added"}        ${dim(
      project ? `(${s.asked} direct deps)` : `(${s.direct} direct, you asked for ${s.asked})`
    )}${dupNote}`
  );
  out.push(`  👤 ${bold(String(s.maintainers))} maintainer${s.maintainers === 1 ? "" : "s"} you'd be trusting`);
  out.push(`  💾 ${bold(bytes(s.size))} on disk`);

  if (s.vulns.total) {
    const v = s.vulns;
    const parts = [
      v.critical && `${v.critical} critical`,
      v.high && `${v.high} high`,
      v.moderate && `${v.moderate} moderate`,
      v.low && `${v.low} low`,
    ].filter(Boolean);
    out.push(`  ${red("🛡")}  ${bold(red(String(v.total)))} ${red(`known vulnerabilit${v.total > 1 ? "ies" : "y"} (${parts.join(", ")})`)}`);
    const rank = { critical: 0, high: 1, moderate: 2, low: 3 };
    const top = [...v.list].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 4);
    for (const x of top)
      out.push(`     ${red("[" + x.severity + "]")} ${dim(x.pkg + "@" + x.version)} ${x.title.slice(0, 52)}`);
  } else {
    out.push(`  ${green("✓")}  no known vulnerabilities`);
  }

  if (s.installScripts.length) {
    const n = s.installScripts.length;
    out.push(`  ${red("⚠")}  ${bold(red(String(n)))} ${red(`package${n > 1 ? "s" : ""} run${n > 1 ? "" : "s"} code on your machine at install:`)}`);
    const shown = [...s.installScripts].sort((a, b) => (b.danger?.length || 0) - (a.danger?.length || 0)).slice(0, 6);
    for (const r of shown) {
      const flag = r.danger?.length ? ` ${red("🚨 " + r.danger.join(", "))}` : "";
      out.push(`     ${bold(r.name)}${flag}`);
      for (const cmd of r.installCmds) {
        const danger = scanDanger(cmd.cmd).length > 0;
        let txt = cmd.cmd.replace(/\s+/g, " ").trim();
        if (txt.length > 72) txt = txt.slice(0, 71) + "…";
        out.push(`       ${dim(cmd.phase + ":")} ${danger ? red(txt) : gray(txt)}`);
      }
    }
    if (n > 6) out.push(dim(`     +${n - 6} more`));
  } else {
    out.push(`  ${green("✓")}  no install scripts`);
  }

  if (s.deprecated.length) out.push(`  🪦 ${bold(String(s.deprecated.length))} deprecated package(s)`);
  if (s.oldest) {
    const a = age(s.oldest.publishedAt);
    const staleTag = s.stale.length ? dim(` (${s.stale.length} stale, 2y+)`) : "";
    out.push(`  🕰  oldest dep last shipped ${bold(a)} ago${a === "?" ? "" : dim(" — " + s.oldest.name)}${staleTag}`);
  }
  out.push(line);
  out.push(`  ${bold("GRADE")}  ${bold(gradeColor(s.grade))}   ${dim('"' + s.quip + '"')}`);
  if (errCount) out.push(gray(`  note: ${errCount} package(s) could not be resolved`));
  out.push(gray("  resolved like npm — highest version satisfying each range"));
  out.push("");
  console.log(out.join("\n"));
}

// ===================== shutdown =====================
// Close undici's keepalive dispatcher and let the loop drain via exitCode,
// instead of process.exit() which can trip a libuv assertion on Windows Node 24.
async function shutdown(code) {
  try {
    const d = globalThis[Symbol.for("undici.globalDispatcher.1")];
    if (d && typeof d.close === "function") await d.close();
  } catch {}
  process.exitCode = code;
}

// ===================== main =====================
function usage() {
  console.log(
    `\n  ${bold("depit")} ${dim("— should i install this?")}\n\n` +
    `  ${cyan("npx depit <package>")}   ${dim("audit one package before you add it")}\n` +
    `  ${cyan("npx depit")}             ${dim("audit every dependency in ./package.json")}\n\n` +
    `  e.g.  ${dim("npx depit express")}\n`
  );
}

function readProjectDeps() {
  const file = resolvePath(process.cwd(), "package.json");
  if (!existsSync(file)) return null;
  let json;
  try { json = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const fields = ["dependencies", "devDependencies", "optionalDependencies"];
  const seeds = [];
  const seen = new Set();
  for (const f of fields)
    for (const [name, spec] of Object.entries(json[f] || {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      seeds.push({ name, spec, depth: 1 });
    }
  return { name: json.name || "this project", seeds };
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const spinner = () => process.stdout.isTTY && process.stdout.write(dim("  resolving…\r"));
  const clearSpinner = () => process.stdout.isTTY && process.stdout.write("              \r");

  // ---- project mode: no package given ----
  if (!argv.length) {
    const proj = readProjectDeps();
    if (!proj) { usage(); return shutdown(1); }
    if (!proj.seeds.length) {
      console.log(`\n  ${green("✓")} ${bold(proj.name)} has no dependencies.\n`);
      return shutdown(0);
    }
    spinner();
    const { records, errors } = await resolveSeeds(proj.seeds);
    clearSpinner();
    if (!records.length) { console.error(`\n  ${red("✗")} could not resolve dependencies\n`); return shutdown(1); }
    await fetchAdvisories(records);
    const s = score(records, { asked: proj.seeds.length });
    render({ subject: proj.name, project: true }, s, errors.length);
    return shutdown(s.grade === "F" ? 2 : 0);
  }

  // ---- single package mode ----
  const { name, version } = parseArg(argv[0]);
  spinner();
  let result;
  try {
    result = await resolveSeeds([{ name, spec: version, depth: 0 }]);
  } catch (e) {
    clearSpinner();
    console.error(`\n  ${red("✗")} ${e.message}\n`);
    return shutdown(1);
  }
  clearSpinner();
  if (!result.records.length) {
    console.error(`\n  ${red("✗")} could not resolve ${name}\n`);
    return shutdown(1);
  }
  await fetchAdvisories(result.records);
  const root = result.records.find((r) => r.name === name && r.depth === 0);
  const s = score(result.records, { excludeKey: root && root.key, asked: 1 });
  render({ subject: name, version }, s, result.errors.length);
  return shutdown(s.grade === "F" ? 2 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await shutdown(1);
});
