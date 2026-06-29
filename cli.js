#!/usr/bin/env node
// shouldi — "should i install <pkg>?"
// Resolves a package's dependency tree straight from the npm registry
// (no install, no node_modules) and prints a scorecard: how many packages
// you'd really add, how much disk, and how many run install scripts on your
// machine. Zero runtime dependencies.

const REGISTRY = process.env.SHOULDI_REGISTRY || "https://registry.npmjs.org";
// Full packument — carries maintainers, publish times, and scripts, which the
// abbreviated form drops. One request per package covers every metric.
const ACCEPT = "application/json";
const CONCURRENCY = 12;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const STALE_MS = 2 * YEAR_MS; // last publish older than this = stale

// ---------- tiny ANSI (no deps) ----------
const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const bold = c("1");
const dim = c("2");
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");
const gray = c("90");

// ---------- helpers ----------
// Node 18-24 keeps undici's keepalive sockets open after fetch, which delays a
// clean exit and, on Windows Node 24, can trip a libuv assertion when
// process.exit() races those handles. Close the dispatcher and let the loop
// drain naturally via process.exitCode instead.
async function shutdown(code) {
  try {
    const d = globalThis[Symbol.for("undici.globalDispatcher.1")];
    if (d && typeof d.close === "function") await d.close();
  } catch {}
  process.exitCode = code;
}

function parseArg(spec) {
  // supports: name, name@version, @scope/name, @scope/name@version
  let name = spec;
  let version = "";
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    name = spec.slice(0, at);
    version = spec.slice(at + 1);
  }
  return { name, version };
}

function bytes(n) {
  if (!n) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
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

// Full packuments don't carry the abbreviated `hasInstallScript` boolean, so
// detect it the way npm does: presence of an install-lifecycle script.
function hasInstallScript(meta) {
  const s = meta.scripts || {};
  return !!(s.install || s.preinstall || s.postinstall);
}

async function fetchPackument(name) {
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  const res = await fetch(url, { headers: { accept: ACCEPT } });
  if (res.status === 404) throw new Error(`package not found: ${name}`);
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
  return res.json();
}

function pickVersion(packument, wanted) {
  const tags = packument["dist-tags"] || {};
  if (wanted && packument.versions && packument.versions[wanted]) return wanted;
  if (wanted && tags[wanted]) return tags[wanted];
  return tags.latest || Object.keys(packument.versions || {}).pop();
}

// ---------- resolver ----------
// Estimate, not a full semver resolver: each unique package is counted once,
// resolved to its latest published version. Good enough to show the shape and
// risk of what you'd pull in; flagged as an estimate in the output.
async function resolve(rootName, rootVersion) {
  const seen = new Map(); // name -> {version, size, installScript, deprecated}
  const errors = [];
  let queue = [{ name: rootName, version: rootVersion, depth: 0 }];

  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => {
        if (seen.has(item.name)) return null;
        seen.set(item.name, null); // reserve slot to avoid dup fetches
        try {
          const pkg = await fetchPackument(item.name);
          const v = pickVersion(pkg, item.depth === 0 ? rootVersion : "");
          const meta = (pkg.versions || {})[v] || {};
          const record = {
            name: item.name,
            version: v,
            depth: item.depth,
            size: (meta.dist && meta.dist.unpackedSize) || 0,
            installScript: hasInstallScript(meta),
            deprecated: !!meta.deprecated,
            deps: Object.keys(meta.dependencies || {}),
            maintainers: (pkg.maintainers || meta.maintainers || [])
              .map((m) => (typeof m === "string" ? m : m && m.name))
              .filter(Boolean),
            publishedAt: (pkg.time && pkg.time[v]) || null,
          };
          seen.set(item.name, record);
          return record;
        } catch (e) {
          seen.delete(item.name);
          errors.push(`${item.name}: ${e.message}`);
          return null;
        }
      })
    );
    for (const r of results) {
      if (!r) continue;
      for (const dep of r.deps) {
        if (!seen.has(dep)) queue.push({ name: dep, version: "", depth: r.depth + 1 });
      }
    }
  }

  const records = [...seen.values()].filter(Boolean);
  return { records, errors };
}

// ---------- scoring ----------
function score(records, rootName) {
  const deps = records.filter((r) => r.name !== rootName);
  const total = deps.length;
  const size = records.reduce((a, r) => a + r.size, 0);
  const installScripts = records.filter((r) => r.installScript);
  const deprecated = records.filter((r) => r.deprecated);
  const direct = records.filter((r) => r.depth === 1).length;

  // people you'd be trusting: union of maintainers across the whole tree
  const maintainerSet = new Set();
  for (const r of records) for (const m of r.maintainers) maintainerSet.add(m);
  const maintainers = maintainerSet.size;

  // staleness: oldest dep + how many haven't shipped in 2+ years
  const dated = records.filter((r) => r.publishedAt);
  const now = Date.now();
  let oldest = null;
  for (const r of dated)
    if (!oldest || Date.parse(r.publishedAt) < Date.parse(oldest.publishedAt))
      oldest = r;
  const stale = dated.filter((r) => now - Date.parse(r.publishedAt) > STALE_MS);

  let pts = 100;
  pts -= Math.min(40, installScripts.length * 8);
  pts -= Math.min(24, deprecated.length * 6);
  pts -= Math.min(15, stale.length * 3);
  if (size > 50e6) pts -= 20;
  else if (size > 10e6) pts -= 10;
  else if (size > 2e6) pts -= 5;
  if (total > 500) pts -= 20;
  else if (total > 200) pts -= 12;
  else if (total > 50) pts -= 6;
  pts = Math.max(0, pts);

  const grade =
    pts >= 90 ? "A" : pts >= 80 ? "B" : pts >= 70 ? "C" : pts >= 55 ? "D" : "F";

  const oldestYears = oldest ? (now - Date.parse(oldest.publishedAt)) / YEAR_MS : 0;

  let quip;
  if (installScripts.length)
    quip = `${installScripts.length} package${installScripts.length > 1 ? "s" : ""} run${installScripts.length > 1 ? "" : "s"} code on your machine at install — review before trusting.`;
  else if (deprecated.length) quip = "ships deprecated packages — may rot soon.";
  else if (oldestYears >= 4 && pts < 88)
    quip = "some deps haven't shipped in years — may be unmaintained.";
  else if (total > 200) quip = "heavy. one import, a whole neighborhood moves in.";
  else if (total === 0) quip = "zero dependencies. install with confidence.";
  else if (total <= 10) quip = "lean. safe to add.";
  else quip = "fine — typical for its size.";

  return {
    total,
    size,
    installScripts,
    deprecated,
    direct,
    maintainers,
    oldest,
    stale,
    grade,
    quip,
    pts,
  };
}

// ---------- render ----------
function render(rootName, rootVersion, s, errCount) {
  const line = gray("  " + "─".repeat(40));
  const gradeColor =
    s.grade === "A" || s.grade === "B"
      ? green
      : s.grade === "C"
      ? yellow
      : red;

  const out = [];
  out.push("");
  out.push(
    `  ${dim("should i install")} ${bold(cyan(rootName))}${
      rootVersion ? dim("@" + rootVersion) : ""
    } ${dim("?")}`
  );
  out.push("");
  out.push(
    `  📦 ${bold(String(s.total))} packages added        ${dim(
      `(${s.direct} direct, you asked for 1)`
    )}`
  );
  out.push(
    `  👤 ${bold(String(s.maintainers))} maintainer${
      s.maintainers === 1 ? "" : "s"
    } you'd be trusting`
  );
  out.push(`  💾 ${bold(bytes(s.size))} on disk`);
  if (s.installScripts.length) {
    out.push(
      `  ${red("⚠")}  ${bold(red(String(s.installScripts.length)))} ${red(
        `package${s.installScripts.length > 1 ? "s" : ""} run${
          s.installScripts.length > 1 ? "" : "s"
        } install scripts on your machine`
      )}`
    );
    const names = s.installScripts
      .map((r) => r.name)
      .slice(0, 6)
      .join(", ");
    out.push(
      `     ${dim(names)}${
        s.installScripts.length > 6 ? dim(` +${s.installScripts.length - 6} more`) : ""
      }`
    );
  } else {
    out.push(`  ${green("✓")}  no install scripts`);
  }
  if (s.deprecated.length)
    out.push(`  🪦 ${bold(String(s.deprecated.length))} deprecated package(s)`);
  if (s.oldest) {
    const a = age(s.oldest.publishedAt);
    const staleTag = s.stale.length
      ? dim(` (${s.stale.length} stale, 2y+)`)
      : "";
    out.push(
      `  🕰  oldest dep last shipped ${bold(a)} ago${
        a === "?" ? "" : dim(" — " + s.oldest.name)
      }${staleTag}`
    );
  }
  out.push(line);
  out.push(
    `  ${bold("GRADE")}  ${bold(gradeColor(s.grade))}   ${dim('"' + s.quip + '"')}`
  );
  if (errCount)
    out.push(gray(`  note: ${errCount} package(s) could not be resolved`));
  out.push(gray("  estimate — latest version of each unique dependency"));
  out.push("");
  console.log(out.join("\n"));
}

// ---------- main ----------
async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (!argv.length) {
    console.log(
      `\n  ${bold("shouldi")} ${dim("— should i install this npm package?")}\n\n  usage: ${cyan(
        "npx shouldi <package>"
      )}\n  e.g.   ${dim("npx shouldi express")}\n`
    );
    process.exit(argv.length ? 0 : 1);
  }

  const { name, version } = parseArg(argv[0]);
  if (process.stdout.isTTY) process.stdout.write(dim("  resolving…\r"));

  let result;
  try {
    result = await resolve(name, version);
  } catch (e) {
    console.error(`\n  ${red("✗")} ${e.message}\n`);
    return shutdown(1);
  }
  if (process.stdout.isTTY) process.stdout.write("            \r");

  if (!result.records.length) {
    console.error(`\n  ${red("✗")} could not resolve ${name}\n`);
    return shutdown(1);
  }

  const s = score(result.records, name);
  render(name, version, s, result.errors.length);

  // non-zero exit on risky grades so it can gate CI / pre-install hooks
  return shutdown(s.grade === "F" ? 2 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await shutdown(1);
});
