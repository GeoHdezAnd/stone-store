export interface Noun {
  singular: string;
  plural: string;
  /** Género gramatical para artículos y terminaciones (la piedra / el acabado). */
  feminine?: boolean;
}

/** Textos de las pantallas de catálogo derivados del sustantivo. Un solo lugar para el español. */
export function catalogLabels({ singular, plural, feminine = false }: Noun) {
  const a = feminine ? 'a' : 'o';
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    newButton: `Nuev${a} ${singular}`,
    createTitle: `Nuev${a} ${singular}`,
    editTitle: `Editar ${singular}`,
    searchLabel: `Buscar ${singular}`,
    filterAll: `Tod${a}s`,
    filterActive: `Activ${a}s`,
    filterInactive: `Inactiv${a}s`,
    active: feminine ? 'Activa' : 'Activo',
    inactive: feminine ? 'Inactiva' : 'Inactivo',
    empty: `Todavía no hay ${plural}. Crea ${feminine ? 'la primera' : 'el primero'}.`,
    noMatches: `${feminine ? 'Ninguna' : 'Ningún'} ${singular} coincide con el filtro.`,
    created: `${cap(singular)} cread${a}.`,
    updated: `${cap(singular)} actualizad${a}.`,
    deactivated: `${cap(singular)} dad${a} de baja.`,
    reactivated: `${cap(singular)} reactivad${a}.`,
    deactivateBody: (name: string) =>
      `«${name}» dejará de mostrarse en el sitio público al publicar. Podrás reactivar${feminine ? 'la' : 'lo'} después.`,
    deactivateTitle: `Dar de baja ${feminine ? 'la' : 'el'} ${singular}`,
  };
}

export type CatalogLabels = ReturnType<typeof catalogLabels>;
