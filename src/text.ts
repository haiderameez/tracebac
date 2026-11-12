export const canon = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}$€£%.,/]+/gu, ' ').replace(/\s+/g, ' ').trim();
