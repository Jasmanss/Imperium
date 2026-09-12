/**
 * Copy text to the clipboard. navigator.clipboard only exists in secure
 * contexts, and the app is usually served over plain http on the LAN, so this
 * falls back to selecting a temporary textarea and running the copy command.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or unsupported: try the fallback below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.className = "clipboard-buffer";
  document.body.appendChild(textarea);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (selection && previous) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}
