// Tiny DOM helpers shared by the page modules.

export const $ = (id) => document.getElementById(id);

/** Value of a CSS custom property, e.g. css('--mc'). */
export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Fills an element from ["text", ["b", "bold text", "class"], …]; data never goes through innerHTML. */
export function fill(el, parts) {
  el.replaceChildren(
    ...parts
      .filter((p) => p != null && p !== false && p !== '')
      .map((p) => {
        if (typeof p === 'string') return document.createTextNode(p);
        const [tag, text, cls] = p;
        const node = document.createElement(tag);
        node.textContent = text;
        if (cls) node.className = cls;
        return node;
      }),
  );
}

/** Replaces a <select>'s options with [value, label] pairs. */
export function setOptions(select, options) {
  select.replaceChildren(
    ...options.map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    }),
  );
}

/** localStorage that never throws (private mode, disabled storage, …). */
export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};
