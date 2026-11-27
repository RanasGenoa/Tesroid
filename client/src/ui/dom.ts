export function getDoc(container: HTMLElement): Document {
  return container.ownerDocument ?? globalThis.document;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options?: {
    readonly className?: string;
    readonly text?: string;
    readonly attrs?: Readonly<Record<string, string>>;
  },
  children?: readonly (HTMLElement | string)[],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (options?.className !== undefined && options.className.length > 0) {
    node.className = options.className;
  }
  if (options?.text !== undefined) {
    node.textContent = options.text;
  }
  if (options?.attrs !== undefined) {
    for (const [key, val] of Object.entries(options.attrs)) {
      node.setAttribute(key, val);
    }
  }
  if (children !== undefined) {
    for (const child of children) {
      if (typeof child === "string") {
        node.appendChild(doc.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
  }
  return node;
}

export function touchButton(
  doc: Document,
  label: string,
  onClick: () => void,
  options?: {
    readonly className?: string;
    readonly attrs?: Readonly<Record<string, string>>;
    readonly disabled?: boolean;
  },
): HTMLButtonElement {
  const btn = el(doc, "button", {
    className: options?.className ?? "btn",
    text: label,
    attrs: {
      type: "button",
      ...(options?.attrs ?? {}),
    },
  });
  if (options?.disabled) {
    btn.disabled = true;
  }
  btn.addEventListener("click", onClick);
  return btn;
}
