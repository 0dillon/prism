/**
 * Structured logging (PRD 6.5). One JSON object per line so logs can be searched and
 * joined by request id. Never pass secrets, learner free text, or audio transcripts.
 */

type Level = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

function write(level: Level, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
