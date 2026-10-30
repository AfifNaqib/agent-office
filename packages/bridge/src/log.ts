// Logging (plan §11): never request bodies, tokens or Access JWTs. Only event kind,
// id prefix and status, plus fixed messages and counts. Nothing request-derived is
// ever interpolated into a message.
export interface Logger {
  /** One accepted/rejected hook event: kind, first 8 chars of the id, status. */
  event(kind: string, id: string, status: string): void;
  info(message: string): void;
  warn(message: string): void;
}

const ID_PREFIX = 8;

/** Only characters that cannot carry anything interesting: kind names are `a.b`, statuses are words or numbers. */
function safe(s: string, max: number): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, max);
}

export function consoleLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  return {
    event: (kind, id, status) => {
      write(`event ${safe(kind, 40)} ${safe(id, ID_PREFIX)} ${safe(status, 20)}`);
    },
    info: (m) => {
      write(`info ${m}`);
    },
    warn: (m) => {
      write(`warn ${m}`);
    },
  };
}

export const silentLogger: Logger = { event: () => undefined, info: () => undefined, warn: () => undefined };
