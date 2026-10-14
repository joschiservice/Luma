import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  type DataRegion,
  dataRegions,
  regionOptions,
  returnPath,
} from '../../kit/identity/data';
import { regionLabel } from '../../kit/identity/region';

/** Suggests placement from non-sensitive browser settings without confirming it for the person. */
function suggestedRegion(
  timeZone: string,
  languages: readonly string[],
): DataRegion | undefined {
  if (timeZone.startsWith('Australia/')) return 'AU';
  if (timeZone.startsWith('Europe/')) return 'EU';
  if (
    [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Pacific/Honolulu',
      'America/Anchorage',
    ].includes(timeZone)
  )
    return 'US';
  if (languages.some((language) => /-AU$/i.test(language))) return 'AU';
  if (languages.some((language) => /-US$/i.test(language))) return 'US';

  return undefined;
}

/** Requires an explicit selection before account fields appear; other enabled cells receive a clean navigation. */
export function RegionChoice({
  returnTo,
  onConfirm,
}: {
  returnTo: string;
  onConfirm: (region: DataRegion) => void;
}) {
  const config = useQuery(regionOptions());
  const [selected, setSelected] = useState<DataRegion>();
  const [suggestion] = useState(() =>
    suggestedRegion(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.languages,
    ),
  );
  if (config.isPending)
    return <p role="status">{m.identity_region_loading()}</p>;
  if (config.isError)
    return (
      <>
        <p role="alert">{m.identity_region_failed()}</p>
        <Button variant="outline" onClick={() => void config.refetch()}>
          {m.identity_region_retry()}
        </Button>
      </>
    );

  return (
    <form
      className="auth-region-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected || !config.data.enabledRegions.includes(selected)) return;
        if (selected === config.data.region) onConfirm(selected);
        else {
          const origin = config.data.regionalOrigins[selected];
          if (!origin) return;
          const destination = new URL('/sign-up', origin);
          destination.searchParams.set('returnTo', returnPath(returnTo));
          window.location.assign(destination.href);
        }
      }}
    >
      <fieldset className="auth-region-options">
        <legend>{m.identity_region_label()}</legend>
        {dataRegions.map((region) => {
          const available =
            config.data.enabledRegions.includes(region) &&
            (region === config.data.region ||
              !!config.data.regionalOrigins[region]);

          return (
            <label key={region} className="auth-region-option">
              <input
                type="radio"
                name="data-region"
                value={region}
                checked={selected === region}
                disabled={!available}
                onChange={() => setSelected(region)}
              />
              <span>
                <strong>{regionLabel(region)}</strong>
                <small>
                  {!available
                    ? m.identity_region_unavailable()
                    : suggestion === region
                      ? m.identity_region_suggested()
                      : region}
                </small>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="field-help">{m.identity_region_boundary()}</p>
      <Button size="lg" type="submit" disabled={!selected}>
        {m.identity_region_continue()}
      </Button>
    </form>
  );
}
