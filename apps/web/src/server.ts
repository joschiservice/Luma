import { paraglideMiddleware } from '@luma/i18n/server';
import handler from '@tanstack/react-start/server-entry';

import { globalEntryRedirect } from './global-entry';

/**
 * Serves the web app with the request's interface language, read from the language cookie or
 * the browser's preferred languages, available to every render and server handler.
 */
export default {
  fetch(request: Request): Promise<Response> {
    const redirect = globalEntryRedirect(request, process.env);
    if (redirect) return Promise.resolve(redirect);

    return paraglideMiddleware(request, () => handler.fetch(request));
  },
};
