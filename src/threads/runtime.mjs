export const MIN_NODE = '24.15.0';
export function supportedNode(version = process.versions.node) {
  const parts = String(version).replace(/^v/, '').split('.').map(Number);
  const minimum = MIN_NODE.split('.').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isSafeInteger(n) || n < 0)) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}
