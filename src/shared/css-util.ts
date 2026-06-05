// Rewrite relative url(...) refs in a CSS string to absolute, resolved against
// the stylesheet's own location. WHY: a captured/fetched sheet is replayed from
// the extension origin (or inlined into a snapshot whose <base> is the page
// URL), so relative font/image URLs would otherwise resolve against the wrong
// origin and 404. Absolute/data/hash URLs are left untouched.
export function absolutizeCss(css: string, baseHref: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (m: string, quote: string, url: string): string => {
      if (/^(?:data:|https?:|\/\/|#)/i.test(url)) return m;
      try {
        return `url(${quote}${new URL(url, baseHref).href}${quote})`;
      } catch {
        return m;
      }
    },
  );
}
