// Keep this loader native ESM: jiti also intercepts dynamic imports in TS.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function loadBridge() {
  const bridge = new URL('./cli.mjs', import.meta.url);
  const digest = createHash('sha256').update(readFileSync(bridge)).digest('hex');
  bridge.searchParams.set('v', digest);
  return import(bridge.href);
}
