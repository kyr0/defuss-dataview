// JSON highlighting as Code Example lines: one <span> per line, keys and strings in the block's own token classes
// (.mk-code-block-k, .mk-code-block-s), numbers and literals in .dv-json-literal. The request editor on the landing page
// and the demo's inspector both render through it, so the two always colour JSON alike.
// Text goes in through textContent only: the JSON may hold anything a user typed.
// VERIFIED: tests/e2e/docs.spec.ts finds the highlighted keys in the landing editor and in the demo inspector.
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** The lines of a JSON text as highlighted <span> elements; an empty line keeps its height. */
export function jsonLines(text) {
  return text.split('\n').map((source) => {
    const line = document.createElement('span');
    let last = 0;
    for (const match of source.matchAll(TOKEN)) {
      if (match.index > last) line.append(source.slice(last, match.index));
      const token = document.createElement('span');
      token.className = match[1] ? (match[2] ? 'mk-code-block-k' : 'mk-code-block-s') : 'dv-json-literal';
      token.textContent = match[1] ?? match[0];
      line.append(token);
      if (match[2]) line.append(match[2]);
      last = match.index + match[0].length;
    }
    line.append(source.slice(last) || (last ? '' : ' '));
    return line;
  });
}

// JavaScript highlighting for short, trusted samples such as the compute panel's plans: comments, strings and keywords
// in the block's token classes, numbers and literals in .dv-json-literal, and called method names as keys. A sample
// written for this page never needs a real parser; this covers the subset those samples use.
// VERIFIED: tests/e2e/docs.spec.ts finds the keyword and string tokens in the compute panel's plan.
const CODE = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|await|async|import|export|from|new|return|for|of|if|else|undefined)\b|\b(true|false|null|-?\d+(?:\.\d+)?n?)\b|\.([A-Za-z_$][\w$]*)(?=\()/g;

/** The lines of a JavaScript sample as highlighted <span> elements. */
export function codeLines(text) {
  return text.split('\n').map((source) => {
    const line = document.createElement('span');
    let last = 0;
    for (const match of source.matchAll(CODE)) {
      if (match.index > last) line.append(source.slice(last, match.index));
      const token = document.createElement('span');
      if (match[5]) { line.append('.'); token.className = 'dv-code-call'; token.textContent = match[5]; }
      else {
        token.className = match[1] ? 'mk-code-block-c' : match[2] ? 'mk-code-block-s' : match[3] ? 'mk-code-block-k' : 'dv-json-literal';
        token.textContent = match[0];
      }
      line.append(token);
      last = match.index + match[0].length;
    }
    line.append(source.slice(last) || (last ? '' : ' '));
    return line;
  });
}
