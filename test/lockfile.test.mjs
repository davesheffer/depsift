// Offline unit tests for the lockfile parsers. No network — pure parsing.
// Run with: npm test   (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonc,
  parsePackageLock,
  parsePnpmId,
  parsePnpmLock,
  parseBunLock,
  parseYarnLock,
} from "../cli.js";

const has = (arr, name, version) => arr.some((e) => e.name === name && e.version === version);

test("parseJsonc: comments, trailing commas, // inside strings", () => {
  const o = parseJsonc(`{
    // line comment
    "a": 1, /* block */
    "url": "https://example.com/x", // trailing line comment
    "arr": [1, 2, 3,],
    "obj": { "k": "v", },
  }`);
  assert.equal(o.a, 1);
  assert.equal(o.url, "https://example.com/x"); // // inside string must survive
  assert.equal(o.arr.length, 3);
  assert.equal(o.obj.k, "v");
});

test("parsePnpmId: v9 / v6 / v5 shapes, peers, scopes, underscores", () => {
  assert.deepEqual(parsePnpmId("foo@1.2.3", 9), { name: "foo", version: "1.2.3" });
  assert.deepEqual(parsePnpmId("@scope/pkg@1.2.3", 9), { name: "@scope/pkg", version: "1.2.3" });
  assert.equal(parsePnpmId("react-dom@18.2.0(react@18.2.0)", 9).version, "18.2.0"); // peer stripped
  assert.equal(parsePnpmId("/foo@1.2.3", 6).name, "foo"); // v6 leading slash
  assert.equal(parsePnpmId("/@scope/pkg@1.2.3(react@18)", 6).name, "@scope/pkg");
  assert.deepEqual(parsePnpmId("/foo/1.2.3", 5), { name: "foo", version: "1.2.3" }); // v5 path
  assert.equal(parsePnpmId("/foo/1.2.3_react@16.0.0", 5).version, "1.2.3"); // v5 peer suffix
  // underscore IN the package name (lodash._reinterpolate) must not be mangled
  assert.deepEqual(parsePnpmId("/lodash._reinterpolate/3.0.0", 5), { name: "lodash._reinterpolate", version: "3.0.0" });
  assert.equal(parsePnpmId("foo@github.com/u/r#abc", 9), null); // non-semver git
  assert.equal(parsePnpmId("'@scope/pkg@1.2.3(react@18)'", 6).name, "@scope/pkg"); // quoted key
});

test("parsePnpmLock: v9 packages block, stops before snapshots", () => {
  const r = parsePnpmLock(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express:
        specifier: ^4.0.0
        version: 4.18.2

packages:

  express@4.18.2:
    resolution: {integrity: sha512-aaa}
    engines: {node: '>= 0.10.0'}

  '@scope/util@2.0.0':
    resolution: {integrity: sha512-bbb}

  body-parser@1.20.1(supports-color@9.0.0):
    resolution: {integrity: sha512-ccc}

snapshots:

  express@4.18.2:
    dependencies:
      body-parser: 1.20.1
`);
  assert.ok(has(r, "express", "4.18.2"));
  assert.ok(has(r, "@scope/util", "2.0.0"));
  assert.ok(has(r, "body-parser", "1.20.1")); // peer-suffixed key parsed
  assert.equal(r.length, 3); // did not bleed into snapshots
});

test("parsePnpmLock: v6 slash-prefixed keys", () => {
  const r = parsePnpmLock(`lockfileVersion: '6.0'

packages:

  /lodash@4.17.21:
    resolution: {integrity: sha512-x}
    dev: false

  /@types/node@20.0.0:
    resolution: {integrity: sha512-y}
    dev: true
`);
  assert.ok(has(r, "lodash", "4.17.21"));
  assert.ok(has(r, "@types/node", "20.0.0"));
  assert.equal(r.length, 2);
});

test("parseBunLock: name@version from packages[key][0], skip git", () => {
  const r = parseBunLock(parseJsonc(`{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", "dependencies": { "express": "^4.0.0" } } },
  "packages": {
    "express": ["express@4.18.2", "", { "dependencies": {} }, "sha512-aaa"],
    "@scope/util": ["@scope/util@2.0.0", "", {}, "sha512-bbb"],
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-ccc"],
    "somegit": ["somegit@git+ssh://git@github.com/x/y.git#abc", "", {}, ""],
  }
}`));
  assert.ok(has(r, "express", "4.18.2"));
  assert.ok(has(r, "@scope/util", "2.0.0"));
  assert.ok(has(r, "left-pad", "1.3.0"));
  assert.ok(!r.some((e) => e.name === "somegit")); // git dep skipped
  assert.equal(r.length, 3);
});

test("parsePackageLock: v3 packages map, skip links/git, nested name", () => {
  const r = parsePackageLock({
    lockfileVersion: 3,
    packages: {
      "": { name: "app", dependencies: { express: "^4.0.0" } },
      "node_modules/express": { version: "4.18.2" },
      "node_modules/@scope/util": { version: "2.0.0" },
      "node_modules/express/node_modules/debug": { version: "2.6.9" },
      "node_modules/linked": { link: true, resolved: "../linked" },
      "node_modules/gitdep": { version: "git+ssh://x#abc" },
    },
  });
  assert.ok(has(r, "express", "4.18.2"));
  assert.ok(has(r, "@scope/util", "2.0.0"));
  assert.ok(has(r, "debug", "2.6.9")); // last node_modules segment
  assert.ok(!r.some((e) => e.name === "linked")); // link skipped
  assert.ok(!r.some((e) => e.name === "gitdep")); // git skipped
  assert.equal(r.length, 3);
});

test("parsePackageLock: v1 nested dependencies", () => {
  const r = parsePackageLock({
    lockfileVersion: 1,
    dependencies: {
      express: { version: "4.18.2", dependencies: { debug: { version: "2.6.9" } } },
      lodash: { version: "4.17.21" },
    },
  });
  assert.ok(has(r, "express", "4.18.2"));
  assert.ok(has(r, "debug", "2.6.9"));
  assert.ok(has(r, "lodash", "4.17.21"));
  assert.equal(r.length, 3);
});

test("parseYarnLock: classic v1, multi-descriptor, skip git", () => {
  const r = parseYarnLock(`# THIS IS AN AUTOGENERATED FILE
# yarn lockfile v1


express@^4.0.0:
  version "4.18.2"
  resolved "https://registry.yarnpkg.com/express/-/express-4.18.2.tgz"
  integrity sha512-aaa
  dependencies:
    body-parser "1.20.1"

"@scope/util@^2.0.0", "@scope/util@^2.1.0":
  version "2.0.0"
  resolved "https://registry.yarnpkg.com/@scope/util/-/util-2.0.0.tgz"

gitdep@github:user/repo:
  version "0.0.0-git"
`);
  assert.ok(has(r, "express", "4.18.2"));
  assert.ok(has(r, "@scope/util", "2.0.0")); // first of comma-joined descriptors
  assert.ok(!r.some((e) => e.name === "gitdep")); // github: source skipped
  assert.equal(r.length, 2);
});

test("parseYarnLock: berry v2+, skip workspace + __metadata", () => {
  const r = parseYarnLock(`# This file is generated by running "yarn install"

__metadata:
  version: 6
  cacheKey: 8

"lodash@npm:^4.0.0":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"

"@types/node@npm:^20.0.0":
  version: 20.0.0
  resolution: "@types/node@npm:20.0.0"

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
`);
  assert.ok(has(r, "lodash", "4.17.21"));
  assert.ok(has(r, "@types/node", "20.0.0"));
  assert.ok(!r.some((e) => e.name === "app")); // workspace: skipped
  assert.ok(!r.some((e) => e.name === "__metadata"));
  assert.equal(r.length, 2);
});
