import { localeNames } from '@luma/i18n/locales';
import { m } from '@luma/i18n/messages';
import { getLocale, type Locale, locales, setLocale } from '@luma/i18n/runtime';
import {
  Select,
  type SelectProps,
} from '@luma/ui/components/primitives/select';

/**
 * Chooses the interface language for this browser. Each language is listed in its own name.
 * Choosing another language stores it in a cookie and reloads the page, so server-rendered
 * text and formatting switch together.
 */
export function LanguageSelect(
  props: Pick<
    SelectProps<Locale>,
    'className' | 'aria-labelledby' | 'aria-describedby'
  >,
) {
  return (
    <Select<Locale>
      {...props}
      {...(props['aria-labelledby']
        ? {}
        : { 'aria-label': m.ui_language_label() })}
      value={getLocale()}
      onValueChange={(locale) => {
        if (locale && locale !== getLocale()) void setLocale(locale);
      }}
      options={locales.map((locale) => ({
        value: locale,
        label: localeNames[locale],
      }))}
    />
  );
}
