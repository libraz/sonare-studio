export function children(element: Element | null | undefined, name?: string): Element[] {
  if (!element) return [];
  return Array.from(element.children).filter((child) => !name || child.tagName === name);
}

export function numberAttr(element: Element | null | undefined, name: string): number | null {
  const raw = element?.getAttribute(name);
  if (raw === null || raw === undefined) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

export function boolAttr(element: Element | null | undefined, name: string): boolean {
  const raw = element?.getAttribute(name);
  return raw === 'true' || raw === '1';
}
