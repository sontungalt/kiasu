export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function serialise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { message: v.message, name: v.name, stack: v.stack } : v;
  }
  return out;
}

/** Cloud Logging reads `severity` and `message` from JSON lines on stdout. */
export function createLogger(base: LogFields = {}, write: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (severity: string) => (message: string, fields: LogFields = {}) =>
    write(JSON.stringify({ severity, message, ...serialise(base), ...serialise(fields) }));
  return {
    info: emit("INFO"),
    warn: emit("WARNING"),
    error: emit("ERROR"),
    child: (fields) => createLogger({ ...base, ...fields }, write),
  };
}

export const silentLogger: Logger = createLogger({}, () => {});
