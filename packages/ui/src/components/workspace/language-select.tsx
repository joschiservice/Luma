import { localeNames } from '@luma/i18n/locales';
import { m } from '@luma/i18n/messages';
import { getLocale, type Locale, locales, setLocale } from '@luma/i18n/runtime';
import {
  Select,
  type SelectProps,
} from '@luma/ui/components/primitives/select';
import { Globe } from 'lucide-react';

/**
 * Chooses the interface language for this browser. Each language is listed in its own name.
 * Choosing another language stores it in a cookie and reloads the page, so server-rendered
 * text and formatting switch together. The `quiet` variant shows a globe beside the current
 * language, for the corner of pages outside a workspace.
 */
export function LanguageSelect(
  props: Pick<
    SelectProps<Locale>,
    'className' | 'aria-labelledby' | 'aria-describedby' | 'variant'
  >,
) {
  return (
    <Select<Locale>
      {...props}
      icon={
        props.variant === 'quiet' ? (
          <Globe size={15} aria-hidden="true" />
        ) : undefined
      }
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
