/** Descarga un blob como archivo desde el navegador (sin enlaces con token en la URL). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Se libera con calma: Safari y Firefox necesitan unos segundos para terminar la descarga.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
