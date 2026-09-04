import type { SourceName } from '../domain/standard';

export interface LibraryFileUpsertEvent {
  fileId: number;
  absPath: string;
  source: SourceName;
  previewPages?: Uint8Array[];
}

export type LibraryFileEvent =
  | { type: 'upsert'; file: LibraryFileUpsertEvent }
  | { type: 'remove'; fileId: number };

type Listener = (event: LibraryFileEvent) => void;
const listeners = new Set<Listener>();

export function subscribeLibraryFileEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishLibraryFileUpsert(file: LibraryFileUpsertEvent): void {
  for (const listener of listeners) listener({ type: 'upsert', file });
}

export function publishLibraryFileRemoval(fileId: number): void {
  for (const listener of listeners) listener({ type: 'remove', fileId });
}
