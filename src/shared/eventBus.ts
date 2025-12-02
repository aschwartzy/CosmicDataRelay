import { EventEmitter } from 'events';

export const eventBus = new EventEmitter();

// Allow many listeners since multiple websocket subscribers may exist per source.
eventBus.setMaxListeners(1000);
