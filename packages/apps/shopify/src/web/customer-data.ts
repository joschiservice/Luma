import type { AppUiProps } from '@luma/app-host/web';
import { useEffect, useRef, useState } from 'react';

import { recordDetail, type ShopifyRecordDetail } from '../domain/records.js';
import { recordError } from './record-error.js';

/** Reads private source data without a cache, discarding superseded responses and clearing on refresh. */
export function useCustomerRecord(
  services: AppUiProps['services'],
  input: Record<string, unknown> | null,
) {
  const key = input ? JSON.stringify(input) : '';
  const [state, setState] = useState<{
    key: string;
    data?: ShopifyRecordDetail;
    error?: string;
  }>({ key: '' });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!key) return;
    const request = ++generation.current;
    setState({ key });
    services
      .request('records', JSON.parse(key))
      .then((value) => {
        if (generation.current === request)
          setState({ key, data: recordDetail.parse(value) });
      })
      .catch((error) => {
        if (generation.current === request)
          setState({ key, error: recordError(error, services.error) });
      });

    return () => {
      generation.current++;
    };
  }, [services, key, attempt]);
  useEffect(() => {
    const refresh = () => {
      generation.current++;
      setState({ key: '' });
      setAttempt((value) => value + 1);
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);

    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);
  const current = state.key === key ? state : { key };

  return {
    ...current,
    pending: !!key && !current.data && !current.error,
    refresh: () => {
      generation.current++;
      setState({ key: '' });
      setAttempt((value) => value + 1);
    },
  };
}

/** Builds a workspace customer link containing source IDs only, never contact or search text. */
export function customerHref(
  organizationId: string,
  connectionId: string,
  id: string,
) {
  return `/app/${encodeURIComponent(organizationId)}/customers?${new URLSearchParams({ appId: 'shopify', connectionId, customerId: id })}`;
}
