const prefix = 'luma:invitation:';

/** Keeps invitation credentials in tab-local storage while authentication uses a token-free return path. */
export function retainInvitationToken(href: string): string {
  const url = new URL(href, window.location.origin);
  if (/^\/app\/invitations\/[^/]+\/[^/]+$/.test(url.pathname) && url.hash) {
    sessionStorage.setItem(prefix + url.pathname, url.hash.slice(1));

    return url.pathname + url.search;
  }

  return href;
}

/** Reads the invitation credential retained across sign-in in this browser tab. */
export function invitationToken(path: string): string {
  return sessionStorage.getItem(prefix + path) ?? '';
}

/** Removes a consumed invitation credential from this browser tab. */
export function forgetInvitationToken(path: string): void {
  sessionStorage.removeItem(prefix + path);
}
