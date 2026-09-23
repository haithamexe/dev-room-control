import { instrumentJsx } from './vite.ts';

/** Use as an enforce: 'pre' webpack loader, or a development-only Turbopack rule. */
export default function sourceLoader(this: { mode?: string; rootContext: string; resourcePath: string; cacheable?: () => void; getOptions?: () => { development?: boolean; root?: string } }, source: string) {
  this.cacheable?.();
  const options = this.getOptions?.() || {};
  if (this.mode === 'production' || !(this.mode === 'development' || options.development === true)) return source;
  return instrumentJsx(source, this.resourcePath, options.root || this.rootContext);
}
