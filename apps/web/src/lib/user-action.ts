/** One ID per user action; reuse it for retries and related API calls. */
export function createUserActionHeaders(): { 'x-luma-action-id': string } {
  return { 'x-luma-action-id': crypto.randomUUID() };
}
