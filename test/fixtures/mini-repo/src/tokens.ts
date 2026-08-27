/** Fixture: a plain helper module, so a diff can span more than one file. */
export const mintToken = (user: string, ttlMs: number, now: number): string =>
  `${user}.${String(now + ttlMs)}`;

export const tokenOwner = (token: string): string => token.split(".")[0] ?? "";
