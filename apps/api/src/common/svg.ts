import { ProblemError } from './problem';

// Tenant logo SVG sanitizer (ADR-0011 §4). Allow-list rebuild: the input is tokenized, and the output is
// written from scratch with only the listed elements and attributes; everything else is dropped (elements
// with their whole subtree). Document type declarations, entities and CDATA are refused outright, so no
// external entity or parser trick reaches the output. References may point only inside the document.

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'linearGradient', 'radialGradient',
  'stop', 'clipPath', 'mask', 'title', 'desc', 'text', 'tspan',
]);
const TEXT_ELEMENTS = new Set(['title', 'desc', 'text', 'tspan']);
const ATTRIBUTES = new Set([
  'id', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'width', 'height', 'viewBox', 'points',
  'preserveAspectRatio', 'version', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'transform', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask',
  'maskUnits', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'letter-spacing',
]);
const MAX_ELEMENTS = 5000;
const MAX_DEPTH = 40;

const LOCAL_URL = /^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/y;

function invalid(reason: string): never {
  throw new ProblemError('ASSET_INVALID', `svg: ${reason}`);
}

/** Escapes text while keeping the five XML entities and numeric references the input already used. */
function escapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
      out += '&amp;';
    } else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else out += ch ?? '';
  }
  return out;
}

function safeValue(name: string, value: string): boolean {
  const v = value.trim();
  if (/[<>]/.test(v) || /javascript:|data:|expression\s*\(/i.test(v)) return false;
  if (/url\s*\(/i.test(v)) return LOCAL_URL.test(v) && ['fill', 'stroke', 'clip-path', 'mask'].includes(name);
  return v.length <= 20000;
}

export interface SanitizedSvg {
  svg: string;
  /** Names of the elements and attributes that were removed (deduplicated), for the upload response/audit. */
  removed: string[];
}

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

export function sanitizeSvg(input: string): SanitizedSvg {
  let src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(src)) invalid('document type declarations, entities and CDATA are not allowed');
  src = src.replace(/^\s*<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<\?|<!/.test(src)) invalid('processing instructions are not allowed');

  const removed = new Set<string>();
  const stack: { name: string; kept: boolean }[] = [];
  let out = '';
  let elements = 0;
  let sawRoot = false;
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const text = src.slice(i, next === -1 ? src.length : next);
      i = next === -1 ? src.length : next;
      const top = stack[stack.length - 1];
      if (top?.kept && stack.every((s) => s.kept) && TEXT_ELEMENTS.has(top.name)) out += escapeText(text);
      else if (text.trim() !== '' && stack.length === 0) invalid('text outside the root element');
      continue;
    }
    TAG.lastIndex = i;
    const m = TAG.exec(src);
    if (!m) invalid('malformed markup');
    i = TAG.lastIndex;
    const [, closing, rawName = '', attrs = '', selfClosing] = m;
    const name = rawName;
    if (closing) {
      const open = stack.pop();
      if (open?.name !== name) invalid(`unbalanced </${name}>`);
      if (open.kept && stack.every((s) => s.kept)) out += `</${name}>`;
      continue;
    }
    elements += 1;
    if (elements > MAX_ELEMENTS) invalid('too many elements');
    if (stack.length === 0) {
      if (sawRoot) invalid('more than one root element');
      if (name !== 'svg') invalid('the root element must be <svg>');
      sawRoot = true;
    }
    if (stack.length >= MAX_DEPTH) invalid('nesting too deep');
    const parentKept = stack.every((s) => s.kept);
    const kept = parentKept && ELEMENTS.has(name);
    if (parentKept && !kept) removed.add(`<${name}>`);
    if (kept) {
      let tag = `<${name}`;
      if (stack.length === 0) tag += ' xmlns="http://www.w3.org/2000/svg"';
      for (const a of attrs.matchAll(ATTR)) {
        const attr = a[1] ?? '';
        const value = a[2] ?? a[3];
        if (attr === 'xmlns' || attr.startsWith('xmlns:')) continue;
        if (!ATTRIBUTES.has(attr) || value === undefined || !safeValue(attr, value)) {
          removed.add(`@${attr}`);
          continue;
        }
        tag += ` ${attr}="${escapeText(value)}"`;
      }
      out += selfClosing ? `${tag}/>` : `${tag}>`;
    }
    if (!selfClosing) stack.push({ name, kept });
  }
  if (stack.length > 0) invalid(`unclosed <${stack[stack.length - 1]?.name ?? ''}>`);
  if (!sawRoot) invalid('no <svg> element');
  return { svg: out, removed: [...removed].sort() };
}
