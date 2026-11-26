// Looking up the page's elements by id. These elements are in index.html and
// are there from load on, so the lookup is typed as present, and the type
// argument says what kind of element it is. Elements created later are
// looked up with document.getElementById, which can return null.

export function byId<T extends Element = HTMLElement>(id: string): T {
  return document.getElementById(id) as unknown as T;
}

// The element an event happened on, or null when it was not an element
// (a text node, the document, the window).
export function targetEl(e: Event): Element | null {
  return e.target instanceof Element ? e.target : null;
}
