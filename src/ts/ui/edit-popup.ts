// Opens and closes the one edit popup (EditPopup.svelte) there can be at a
// time. It is mounted on <body> when opened and gone when closed, so that a
// caller (and a test) can tell from its id whether it is open.

import { flushSync, mount, unmount } from 'svelte';
import EditPopup from './EditPopup.svelte';

type PopupProps = {
  id: string; inputId: string; label: string; value: string; hint: string; accent: string;
  labelStyle: string; gap: number; width: number;
  oncommit: (text: string) => void; onclose: () => void;
};

let open: ReturnType<typeof mount> | null = null;

export function openEditPopup(props: PopupProps) {
  closeEditPopup();
  open = mount(EditPopup, { target: document.body, props });
  flushSync();
  const input = document.getElementById(props.inputId) as HTMLInputElement | null;
  if (input) { input.focus(); input.select(); }
}

// Closing it takes the focus from its field, which would close it again.
export function closeEditPopup() {
  if (!open) return;
  const c = open;
  open = null;
  unmount(c);
}

export function editPopupOpen() { return !!open; }
