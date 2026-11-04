// Runtime dependencies are found through this one directory: `vendor/` when a
// bundled copy exists, `node_modules/` otherwise. A bundle copies the packages
// it needs into `vendor/` in the same shape and nothing else has to change.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const vendor = fileURLToPath(new URL('../vendor/', import.meta.url));
export const depsDir = existsSync(vendor) ? vendor : fileURLToPath(new URL('../node_modules/', import.meta.url));

const require = createRequire(import.meta.url);
export const loadDep = (name) => require(depsDir + name);
