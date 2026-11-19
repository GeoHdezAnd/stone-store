import type { MediaEntity } from '@canteras/shared';
import { useMemo } from 'react';
import { useApi } from '../api/ApiContext';
import { createMediaApi } from '../api/mediaApi';
import { PhotoListField } from '../components/PhotoListField';
import type { FieldRenderProps } from '../components/fieldTypes';
import { useToastedAction } from '../hooks/useToastedAction';

/**
 * Campo `custom` de fotos de un registro del catálogo (piedras, proyectos, acabados).
 * Contenedor: sube con toast y agrega la clave al borrador. El id del registro sale del borrador.
 */
export function MediaPhotoField({
  entity,
  props,
  createNote = 'Guarda el registro para poder subir fotos.',
}: {
  entity: MediaEntity;
  props: FieldRenderProps;
  /** Nota que se muestra en el alta (la subida necesita que el id ya exista). */
  createNote?: string;
}) {
  const apiFetch = useApi();
  const media = useMemo(() => createMediaApi(apiFetch), [apiFetch]);
  const { pending, run } = useToastedAction();
  const ownerId = typeof props.values.id === 'string' ? props.values.id : '';
  const photos = Array.isArray(props.value) ? props.value : [];

  return (
    <PhotoListField
      value={photos}
      onChange={props.onChange}
      disabled={props.disabled}
      uploading={pending}
      uploadBlockedReason={props.mode === 'create' ? createNote : undefined}
      onUpload={(file) =>
        run(() => media.upload(entity, ownerId, file), {
          loading: 'Subiendo foto…',
          success: 'Foto subida. Guarda los cambios para conservarla.',
        })
      }
    />
  );
}
