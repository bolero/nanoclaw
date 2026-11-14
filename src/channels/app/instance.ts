/** The app channel store, shared by the adapter and the `ncl app` commands (same host process). */
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { AppStore } from './store.js';

let sharedStore: AppStore | null = null;

export function getAppStore(): AppStore {
  if (!sharedStore) sharedStore = new AppStore(path.join(DATA_DIR, 'app-channel'));
  return sharedStore;
}

/** Test seam: point the shared store elsewhere (or reset it). */
export function setAppStoreForTests(store: AppStore | null): void {
  sharedStore = store;
}
