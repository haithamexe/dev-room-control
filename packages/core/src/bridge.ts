/** Opt-in development metadata. Spread onto a React element or assign as DOM attributes. */
export function sourceProps(input: { file: string; line?: number; component: string; route?: string; handler?: string; state?: string }, enabled = false) {
  if (!enabled) return {};
  return { 'data-dcr-source': input.file, 'data-dcr-line': String(input.line || 1), 'data-dcr-component': input.component, 'data-dcr-route': input.route, 'data-dcr-handler': input.handler, 'data-dcr-state': input.state };
}
