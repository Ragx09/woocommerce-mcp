// pino options shared by the app and the tests. Redaction is the last line of defence (REQ-SEC):
// code should not log secrets in the first place, but if a header or field slips through it is censored.
import type { LoggerOptions } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  '*.authorization',
  '*.password',
  '*.credential',
  '*.apiKey',
  '*.key',
  '*.token',
  '*.secret',
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { svc: 'gateway' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
}
