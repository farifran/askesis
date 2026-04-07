import { describe, it, expect } from 'vitest';
import { sanitize } from '../render/dom';

describe('sanitize (wrapper)', () => {
  it('removes <script> tags and on* attributes and returns string', () => {
    const html = '<div><script>alert(1)</script><p onclick="doIt()">hello</p></div>';
    const clean = sanitize(html);
    expect(clean).not.toContain('<script>');
    expect(clean).not.toContain('onclick=');
    expect(typeof clean).toBe('string');
  });

  it('strips javascript: href but preserves safe hrefs', () => {
    const html = '<a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>';
    const clean = sanitize(html);
    expect(clean).not.toContain('javascript:alert');
    expect(clean).toContain('https://example.com');
  });
});
