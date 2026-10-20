/** How long recorded changes are kept, in days; older cursors need a full reread. */
export const changeRetentionDays = 30;

/**
 * A position in a workspace's change feed: the writing transaction's ID, then the row's ID within
 * it. Both are decimal strings, because transaction IDs exceed JavaScript's safe integers.
 */
export type ChangePosition = {
  xact: string;
  id: string;
};

/** The position before every change. */
export const feedStart: ChangePosition = { xact: '0', id: '0' };

const positionPattern = /^(0|[1-9]\d{0,19}):(0|[1-9]\d{0,18})$/;

/** Encodes a position as an opaque cursor. */
export function writeChangeCursor(position: ChangePosition) {
  return Buffer.from(`${position.xact}:${position.id}`).toString('base64url');
}

/** Decodes a cursor written by `writeChangeCursor`; returns null for anything else. */
export function readChangeCursor(cursor: string): ChangePosition | null {
  const match = positionPattern.exec(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  );

  return match?.[1] && match[2] ? { xact: match[1], id: match[2] } : null;
}
