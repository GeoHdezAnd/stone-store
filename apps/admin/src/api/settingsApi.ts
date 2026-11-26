import type { MailSettings, PublicSettings, QuotingSettings } from '@canteras/shared';
import type { ApiFetch } from './client';

/** Cada fila es `null` si aún no existe (o la API la devolvió inválida). */
export interface SettingsSnapshot {
  public: PublicSettings | null;
  mail: MailSettings | null;
  /** Siempre presente: sin fila guardada la API devuelve `{ ivaPctDefault: null }`. */
  quoting: QuotingSettings;
}

export type SettingsRow = 'public' | 'mail' | 'quoting';

export interface SettingsApi {
  get(): Promise<SettingsSnapshot>;
  /** Solo `owner`: la API responde 403 a `staff`. */
  save(row: SettingsRow, data: PublicSettings | MailSettings | QuotingSettings): Promise<void>;
}

export function createSettingsApi(api: ApiFetch): SettingsApi {
  return {
    get: () => api<SettingsSnapshot>('/admin/settings'),
    save: async (row, data) => {
      await api(`/admin/settings/${row}`, { method: 'PUT', body: data });
    },
  };
}
