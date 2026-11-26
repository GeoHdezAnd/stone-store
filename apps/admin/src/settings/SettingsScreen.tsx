import { mailSettingsSchema, publicSettingsSchema } from '@canteras/shared';
import { useCallback, useMemo } from 'react';
import { useApi } from '../api/ApiContext';
import { createSettingsApi } from '../api/settingsApi';
import { describeError } from '../api/errors';
import { PageHeader } from '../components/PageHeader';
import { useAsyncResource } from '../hooks/useAsyncResource';
import { usePermissions } from '../hooks/usePermissions';
import { MailTemplateHelp } from './MailTemplateHelp';
import { QuotingSection } from './QuotingSection';
import { SettingsSection } from './SettingsSection';
import { mailFields, publicFields } from './sections';

/** Configuración: patio, correo de cotización e IVA por defecto, cada uno con su guardado. */
export function SettingsScreen() {
  const apiFetch = useApi();
  const api = useMemo(() => createSettingsApi(apiFetch), [apiFetch]);
  const { state, reload } = useAsyncResource(useCallback(() => api.get(), [api]));
  const { canEditSettings } = usePermissions();

  return (
    <>
      <PageHeader title="Configuración" />
      {state.status === 'loading' ? (
        <p className="state" role="status">
          Cargando…
        </p>
      ) : state.status === 'error' ? (
        <div className="state">
          <p role="alert">{describeError(state.error)}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            Reintentar
          </button>
        </div>
      ) : (
        <>
          <SettingsSection
            title="Datos del patio"
            description="Se publican en el sitio público."
            schema={publicSettingsSchema}
            sections={[{ fields: publicFields }]}
            initial={state.data.public}
            canEdit={canEditSettings}
            onSave={(values) => api.save('public', values)}
            successMessage="Datos del patio guardados."
          />
          <SettingsSection
            title="Correo de cotización"
            description="Texto del correo que recibe el cliente al enviarle la cotización."
            schema={mailSettingsSchema}
            sections={[{ fields: mailFields }]}
            initial={state.data.mail}
            canEdit={canEditSettings}
            onSave={(values) => api.save('mail', values)}
            successMessage="Correo de cotización guardado."
            renderExtra={(draft) => <MailTemplateHelp draft={draft} />}
          />
          <QuotingSection
            initial={state.data.quoting}
            canEdit={canEditSettings}
            onSave={(values) => api.save('quoting', values)}
          />
        </>
      )}
    </>
  );
}
