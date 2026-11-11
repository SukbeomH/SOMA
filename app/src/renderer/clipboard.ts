/** Missing Clipboard API (plain HTTP) must reject through the caller's fallback. */
export async function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access requires HTTPS or localhost. Select and copy the text manually.');
  await navigator.clipboard.writeText(text);
}
