import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ZodError } from 'zod';
import { jsonResponse } from './http';

/** `testimonio.texto`, `piedras[0]`. Nunca incluye valores, solo la ruta del campo. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

// Los mensajes de zod ya vienen en español (los define packages/shared). Se sustituyen los que
// de otro modo mencionarían nombres de claves enviadas por el cliente o saldrían en inglés.
function toIssue(issue: ZodError['issues'][number]): { path: string; message: string } {
  if (issue.code === 'unrecognized_keys') {
    return { path: formatPath(issue.path), message: 'El cuerpo incluye campos no permitidos' };
  }
  if (issue.code === 'invalid_type' && issue.path.length === 0) {
    return { path: '', message: 'El cuerpo debe ser un objeto JSON' };
  }
  return { path: formatPath(issue.path), message: issue.message };
}

/** 422 `validation_error` con `issues:[{path,message}]` y sin eco de los valores recibidos. */
export function validationErrorResponse(error: ZodError): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(422, { error: 'validation_error', issues: error.issues.map(toIssue) });
}
