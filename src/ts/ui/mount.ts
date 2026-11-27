// The page is one Svelte component, mounted before any module's load-time
// work runs, so that its elements exist from load on, as static markup's
// would.

import { mount } from 'svelte';
import App from './App.svelte';

export function mountComponents() {
  mount(App, { target: document.body, anchor: document.body.firstElementChild ?? undefined });
}
