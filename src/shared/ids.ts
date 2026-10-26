/** Time-ordered UUIDv7: index-friendly primary keys and event ids. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
