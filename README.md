# shouldi

**Should I install this?** See what a single npm dependency *really* drags in — packages, disk, and the install scripts that run code on your machine — **before** you run `npm install`.

```sh
npx shouldi express
```

```
  should i install express ?

  📦 64 packages added        (28 direct, you asked for 1)
  👤 36 maintainers you'd be trusting
  💾 2.1 MB on disk
  ✓  no install scripts
  🕰  oldest dep last shipped 11y ago — ee-first (25 stale, 2y+)
  ────────────────────────────────────────
  GRADE  C   "some deps haven't shipped in years — may be unmaintained."
  estimate — latest version of each unique dependency
```

You asked for **1** package. You got **64**. That's the npm deal — and most of the time you never look. `shouldi` makes you look, in two seconds, with no install.

---

## Why

Every `npm install` is a trust decision you make blind:

- **You add 1 package, you trust 64** — and **36 maintainers** you've never heard of. Each is code, and a person with publish rights, that ends up in your app.
- **Some run scripts on your machine** the moment they install (`postinstall`, `preinstall`). That's the exact door supply-chain attacks walk through.
- **Some are deprecated or abandoned** — `shouldi` shows the oldest dep's last publish, so "last shipped 11 years ago" stops being a surprise *after* it's in your lockfile.

`shouldi` answers all of that **before** you commit, straight from the npm registry. No install. No `node_modules`. No dependencies of its own.

## The scary one: install scripts

```sh
npx shouldi node-sass
```

```
  ⚠  1 package runs install scripts on your machine
     node-sass
  🪦 1 deprecated package(s)
  🕰  oldest dep last shipped 13y ago — async-foreach (30 stale, 2y+)
  ────────────────────────────────────────
  GRADE  D   "1 package runs code on your machine at install — review before trusting."
```

`hasInstallScript` means that package executes its own code during `npm install` — before any of *your* code runs. Usually it's a native build. Sometimes it isn't. `shouldi` shows you which packages do it and how many, so "I'll just install it" becomes a decision instead of a reflex.

## Usage

```sh
npx shouldi <package>
npx shouldi react
npx shouldi @scope/name
npx shouldi left-pad@1.3.0
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
npx shouldi "$NEW_DEP" || exit 1
```

## What the grade means

Starts at 100, loses points for:

- **install scripts** (−8 each) — code that runs on your machine
- **deprecated packages** (−6 each)
- **stale packages** (−3 each) — no publish in 2+ years
- **disk weight** (up to −20)
- **dependency count** (up to −20)

Maintainer count and oldest-publish age are shown for context (they're the *who* and *how-fresh* of what you're trusting); they inform the quip but don't directly move the grade.

`A` install with confidence · `B` fine · `C` look closer · `D` heavy · `F` think twice.

## How it works

Hits the npm registry [packument](https://github.com/npm/registry/blob/master/docs/responses/package-metadata.md) endpoint and walks the dependency graph in parallel — one request per unique package, covering deps, size, install scripts, maintainers, and publish dates in a single fetch. Each unique package is counted once, resolved to its latest version — an **estimate** of the shape and risk of what you'd pull in, not a byte-exact lockfile. Nothing is installed and nothing touches disk.

Zero runtime dependencies. Node 18+.

## Install (optional)

`npx shouldi <pkg>` needs no install. If you want it on your PATH:

```sh
npm i -g shouldi
```

## License

MIT
