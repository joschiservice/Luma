import { paraglideMiddleware } from '@luma/i18n/server';
import handler from '@tanstack/react-start/server-entry';

/**
 * Serves the web app with the request's interface language, read from the language cookie or
 * the browser's preferred languages, available to every render and server handler.
 */
export default {
  fetch(request: Request): Promise<Response> {
    return paraglideMiddleware(request, () => handler.fetch(request));
  },
};
