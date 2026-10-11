// flossy está solo en español por ahora. Los componentes copiados de openGym llaman a t();
// esto la deja en una sustitución de {0}, {1}… para no tocar su código.
export const t = (s, ...args) => String(s).replace(/\{(\d+)\}/g, (_, i) => args[+i] ?? '')
export const tn = (n, one, many) => t(n === 1 ? one : many, n)
