export const el = (id) => document.getElementById(id);

export function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === false) element.removeAttribute(key);
    else if (value !== null && value !== undefined) element.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) element.append(child);
  }
  return element;
}
