const regions = new Map();

export const register = (name, render) => regions.set(name, render);

export const paint = (...names) => {
  for (const name of names) regions.get(name)?.();
};
