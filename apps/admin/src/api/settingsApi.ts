import type { MailSettings, PublicSettings } from '@canteras/shared';
import type { ApiFetch } from './client';

/** Cada fila es `null` si aún no existe (o la API la devolvió inválida). */
export interface SettingsSnapshot {
  public: PublicSettings | null;
  mail: MailSettings | null;
}

export type SettingsRow = 'public' | 'mail';

export interface SettingsApi {
  get(): Promise<SettingsSnapshot>;
  /** Solo `owner`: la API responde 403 a `staff`. */
  save(row: SettingsRow, data: PublicSettings | MailSettings): Promise<void>;
}

export function createSettingsApi(api: ApiFetch): SettingsApi {
  return {
    get: () => api<SettingsSnapshot>('/admin/settings'),
    save: async (row, data) => {
      await api(`/admin/settings/${row}`, { method: 'PUT', body: data });
    },
  };
}
