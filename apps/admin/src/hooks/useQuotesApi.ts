import { useMemo } from 'react';
import { useApi, useApiDownload } from '../api/ApiContext';
import { createQuotesApi } from '../api/quotesApi';
import type { QuotesApi } from '../api/quotesApi';

export function useQuotesApi(): QuotesApi {
  const api = useApi();
  const download = useApiDownload();
  return useMemo(() => createQuotesApi(api, download), [api, download]);
}
