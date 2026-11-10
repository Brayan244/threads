// Canonical JSON keeps the previous SQLite request representation stable.
export function stringify(value, { pretty = false } = {}) {
  const gap = pretty ? 2 : 0;
  function encode(item, depth) {
    if (depth > 128) throw new TypeError('JSON nesting exceeds the supported bound');
    if (typeof item === 'bigint') return String(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Non-finite JSON number');
      return JSON.stringify(item);
    }
    if (!item || typeof item !== 'object') throw new TypeError('Unsupported JSON value');
    const array = Array.isArray(item), entries = array ? item.map(v => encode(v, depth + 1)) :
      Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => JSON.stringify(key) + (gap ? ': ' : ':') + encode(item[key], depth + 1));
    const [open, close] = array ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return open + close;
    if (!gap) return open + entries.join(',') + close;
    const indent = ' '.repeat((depth + 1) * gap);
    return open + '\n' + indent + entries.join(',\n' + indent) + '\n' + ' '.repeat(depth * gap) + close;
  }
  return encode(value, 0);
}

// JSON.parse alone cannot reject duplicate keys, including escaped duplicates.
export function parseJSON(text) {
  if (typeof text !== 'string') throw new TypeError('JSON text required');
  let at = 0;
  const fail = () => { throw new SyntaxError('Invalid JSON input'); };
  const whitespace = () => { while (/[ \t\r\n]/.test(text[at] ?? '\0')) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '"') { at++; return JSON.parse(text.slice(start, at)); }
      if (text[at] === '\\') at++;
      at++;
    }
    return fail();
  }
  function value(depth) {
    if (depth > 128) return fail();
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{') {
      at++; whitespace();
      const result = {}, keys = new Set();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        if (text[at] !== '"') return fail();
        const key = string();
        if (keys.has(key)) return fail();
        keys.add(key); whitespace();
        if (text[at++] !== ':') return fail();
        Object.defineProperty(result, key, {value:value(depth + 1),enumerable:true,writable:true,configurable:true}); whitespace();
        if (text[at] === '}') { at++; return result; }
        if (text[at++] !== ',') return fail();
        whitespace();
      }
    }
    if (char === '[') {
      at++; whitespace(); const result = [];
      if (text[at] === ']') { at++; return result; }
      for (;;) {
        result.push(value(depth + 1)); whitespace();
        if (text[at] === ']') { at++; return result; }
        if (text[at++] !== ',') return fail();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const token = text.slice(at).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (!token) return fail();
    at += token.length;
    const number = Number(token);
    if (!Number.isFinite(number)) return fail();
    return !/[.eE]/.test(token) && !Number.isSafeInteger(number) ? BigInt(token) : number;
  }
  const result = value(0); whitespace();
  if (at !== text.length) return fail();
  return result;
}
