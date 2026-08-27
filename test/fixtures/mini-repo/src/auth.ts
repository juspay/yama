/** Fixture: the "interesting" file — auth-shaped, so review rules have a target. */
export type Session = { user: string; token: string; expiresAt: number };

export const isExpired = (session: Session, now: number): boolean =>
  session.expiresAt <= now;

export const authorize = (session: Session, now: number): boolean =>
  session.token.length > 0 && !isExpired(session, now);
