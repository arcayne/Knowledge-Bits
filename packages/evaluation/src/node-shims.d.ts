declare module 'node:crypto' {
  export function createHash(name: string): { update(value: string | Uint8Array): { digest(encoding: 'hex'): string } };
}
declare module 'node:fs/promises' {
  export function realpath(path: string): Promise<string>;
  export function readFile(path: string, encoding?: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string, options?: { flag?: string }): Promise<void>;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}
declare module 'node:child_process' {
  export function spawn(command: string, options: unknown): {
    stdin: { end(data: string): void };
    stdout: { setEncoding(encoding: string): void; on(event: string, listener: (chunk: string) => void): void };
    stderr: { setEncoding(encoding: string): void; on(event: string, listener: (chunk: string) => void): void };
    on(event: string, listener: (...args: any[]) => void): void;
    kill(signal?: string): void;
  };
}
declare const process: { env: Record<string, string | undefined> };
declare const Buffer: { concat(values: Uint8Array[]): Uint8Array };
declare namespace NodeJS {
  interface ErrnoException { code?: string }
}
