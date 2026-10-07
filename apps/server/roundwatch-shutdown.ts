/** Administrative admission rejection, never provider or negative capability evidence. */
export class ShutdownInterrupted extends Error {
   constructor() {
      super('RoundWatch background shutdown interrupted acquisition');
      this.name = 'ShutdownInterrupted';
   }
}

export function isShutdownInterrupted(error: unknown): error is ShutdownInterrupted {
   return error instanceof ShutdownInterrupted;
}
