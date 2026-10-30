// Relay logging (plan §11 "Logging", NFR observability): one JSON line per request
// outcome, visible with `wrangler tail`. Never bodies, tokens, JWTs or text: only
// the route, status, event kind (from the fixed enum) and an 8-char id prefix.
export interface LogFields {
  readonly route: string;
  readonly status: number | string;
  readonly kind?: string;
  readonly id?: string;
}

export type Logger = (fields: LogFields) => void;

export const consoleLogger: Logger = (fields) => {
  console.log(JSON.stringify(fields));
};

export function idPrefix(id: string): string {
  return id.slice(0, 8);
}
