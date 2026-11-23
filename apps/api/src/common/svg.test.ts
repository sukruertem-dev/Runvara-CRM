import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './svg';

const wrap = (inner: string): string => `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

describe('sanitizeSvg', () => {
  it('keeps shapes, gradients and local references', () => {
    const r = sanitizeSvg(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="#7B3CFF"/></linearGradient></defs><path d="M0 0h10v10z" fill="url(#g)"/>'));
    expect(r.removed).toEqual([]);
    expect(r.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#7B3CFF"/></linearGradient></defs><path d="M0 0h10v10z" fill="url(#g)"/></svg>');
  });

  it('drops scripts, foreignObject and style with their content', () => {
    const r = sanitizeSvg(wrap('<script>alert(1)</script><foreignObject><div onclick="x()">hi</div></foreignObject><style>*{}</style><rect width="1" height="1"/>'));
    expect(r.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1"/></svg>');
    expect(r.removed).toEqual(['<foreignObject>', '<script>', '<style>']);
  });

  it('drops event handlers, external and javascript references', () => {
    const r = sanitizeSvg(wrap('<rect onload="x()" width="1" fill="url(https://evil.test/a.svg#x)"/><a href="javascript:alert(1)"><circle r="1"/></a><path d="M0 0" style="x"/>'));
    expect(r.svg).not.toMatch(/onload|evil|javascript|style|<a/);
    expect(r.removed).toEqual(expect.arrayContaining(['@onload', '@fill', '<a>', '@style']));
  });

  it('escapes text and keeps it only in text elements', () => {
    const r = sanitizeSvg(wrap('<title>A &amp; B &lt;co&gt; & "q"</title><g>stray</g>'));
    expect(r.svg).toContain('<title>A &amp; B &lt;co&gt; &amp; &quot;q&quot;</title>');
    expect(r.svg).toContain('<g></g>');
  });

  it('refuses entities, doctypes, CDATA and non-svg roots', () => {
    expect(() => sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>')).toThrow(/not allowed/);
    expect(() => sanitizeSvg(wrap('<text><![CDATA[x]]></text>'))).toThrow(/not allowed/);
    expect(() => sanitizeSvg('<html><svg/></html>')).toThrow(/root element/);
    expect(() => sanitizeSvg('<svg><g></svg>')).toThrow(/unbalanced/);
    expect(() => sanitizeSvg('<svg><g>')).toThrow(/unclosed/);
  });

  it('accepts an XML declaration and comments', () => {
    expect(sanitizeSvg(`<?xml version="1.0"?><!-- logo -->${wrap('<circle r="2"/>')}`).svg).toContain('<circle r="2"/>');
  });
});
