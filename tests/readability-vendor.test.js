import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'vendor', 'mozilla-readability');

describe('vendored Mozilla Readability', () => {
  it('loads as CommonJS from the isolated vendor package', () => {
    const Readability = require(join(vendorDir, 'Readability.js'));
    assert.equal(typeof Readability, 'function');
    assert.equal(Readability.name, 'Readability');

    const src = readFileSync(join(vendorDir, 'Readability.js'), 'utf8');
    assert.match(src, /function Readability/);
    assert.match(src, /globalThis\.Readability/);
  });

  it('ships Apache-2.0 license notice next to the vendor file', () => {
    const license = readFileSync(join(vendorDir, 'LICENSE'), 'utf8');
    assert.match(license, /Apache License, Version 2\.0/);
  });
});
