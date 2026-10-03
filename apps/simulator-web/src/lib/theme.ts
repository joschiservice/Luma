const query = '(prefers-color-scheme: dark)';

/**
 * Follows the operating system's light or dark appearance, including later changes, by
 * toggling the `dark` class that the shared design tokens read.
 */
export function followSystemTheme() {
  const media = window.matchMedia(query);
  const apply = () =>
    document.documentElement.classList.toggle('dark', media.matches);
  apply();
  media.addEventListener('change', apply);
}
