function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(scope: string, ...args: unknown[]): void {
  console.log(`${stamp()} [${scope}]`, ...args);
}
