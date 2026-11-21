import { describe, expect, it } from 'vitest';
import { ProblemError } from './problem';
import { renderRichText } from './rich-text';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const U = '01900000-0000-7000-8000-000000000001';
const T = '01900000-0000-7000-8000-000000000002';

describe('renderRichText', () => {
  it('renders allowed nodes, escapes text and extracts mentions', () => {
    const r = renderRichText(doc(p(text('Merhaba '), { type: 'mention', attrs: { kind: 'user', id: U } }, text(' <b>', [{ type: 'bold' }])), p({ type: 'mention', attrs: { kind: 'team', id: T } })));
    expect(r.html).toBe(`<p>Merhaba <span class="mention" data-kind="user" data-id="${U}"></span><strong> &lt;b&gt;</strong></p><p><span class="mention" data-kind="team" data-id="${T}"></span></p>`);
    expect(r.text).toBe('Merhaba @ <b>\n@');
    expect([...r.mentions.users]).toEqual([U]);
    expect([...r.mentions.teams]).toEqual([T]);
  });

  it('allows http(s)/mailto links only and rejects unknown nodes and marks', () => {
    expect(renderRichText(doc(p(text('x', [{ type: 'link', attrs: { href: 'https://flexa.app/a?b=1' } }])))).html).toContain('href="https://flexa.app/a?b=1"');
    for (const bad of [
      doc(p(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
      doc({ type: 'image', attrs: { src: 'x' } }),
      doc(p(text('x', [{ type: 'script' }]))),
      doc({ type: 'mention', attrs: { kind: 'user', id: 'not-a-uuid' } }),
      { type: 'paragraph' },
    ]) {
      expect(() => renderRichText(bad)).toThrow(ProblemError);
    }
  });

  it('limits mentions and nesting', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ type: 'mention', attrs: { kind: 'user', id: `01900000-0000-7000-8000-${String(i).padStart(12, '0')}` } }));
    expect(() => renderRichText(doc(p(...many)))).toThrow(/at most 20/);
    let deep: unknown = text('x');
    for (let i = 0; i < 25; i++) deep = { type: 'blockquote', content: [deep] };
    expect(() => renderRichText(doc(deep))).toThrow(/deeply/);
  });
});
