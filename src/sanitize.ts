import { canonicalUrl } from './search.ts';

export function createSanitizer(allowedUrls: Iterable<string>, maxCitation: number) {
  const allowed = new Set([...allowedUrls].map(canonicalUrl));
  const cited = new Set<number>();
  let pending = '';

  const isAllowed = (url: string) => allowed.has(canonicalUrl(url.replace(/[.,;:!?]+$/, '')));

  const clean = (text: string) =>
    text
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, label, url) => (isAllowed(url) ? match : label))
      .replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (_match, list: string) => {
        const valid = list.split(',').map((n) => Number(n.trim())).filter((n) => n >= 1 && n <= maxCitation);
        valid.forEach((n) => cited.add(n));
        return valid.length ? `[${valid.join(', ')}]` : '';
      })
      .replace(/https?:\/\/[^\s)\]>"']+/g, (url) => (isAllowed(url) ? url : ''));

  return {
    push(delta: string): string {
      pending += delta;
      const cut = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n'));
      if (cut < 0) return '';
      const ready = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      return clean(ready);
    },
    flush(): string {
      const rest = clean(pending);
      pending = '';
      return rest;
    },
    cited: () => [...cited].sort((a, b) => a - b),
  };
}
