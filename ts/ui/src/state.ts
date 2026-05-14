/**
 * Shared services — a single SessionStore + KvStorage that all views
 * reach for, so we don't get one-per-view instances and they all see
 * the same persisted data.
 */

import { SessionStore } from '../../src/platform/index.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';

export const sharedKv = new LocalStorageKv();
export const sessionStore = new SessionStore(sharedKv);
