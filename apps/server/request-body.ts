export class RequestBodyTooLargeError extends Error {
   constructor(readonly limitBytes: number) {
      super(`Request body exceeds ${limitBytes} bytes`);
      this.name = 'RequestBodyTooLargeError';
   }
}

export class RequestBodyReadTimeoutError extends Error {
   constructor(readonly timeoutMilliseconds: number) {
      super(`Request body read exceeded ${timeoutMilliseconds} ms`);
      this.name = 'RequestBodyReadTimeoutError';
   }
}

export const MAX_MCP_REQUEST_BODY_BYTES = 32 * 1024;
export const MAX_WATCH_REQUEST_BODY_BYTES = 8 * 1024;

export async function readJsonBodyWithLimit(
   request: Request,
   limitBytes: number,
   timeoutMilliseconds?: number,
): Promise<unknown> {
   if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error('limitBytes must be a positive safe integer');
   }
   if (
      timeoutMilliseconds !== undefined &&
      (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0)
   ) {
      throw new Error('timeoutMilliseconds must be a positive finite number');
   }

   const declaredLength = parseDeclaredLength(
      request.headers.get('content-length'),
   );
   if (declaredLength !== undefined && declaredLength > limitBytes) {
      throw new RequestBodyTooLargeError(limitBytes);
   }

   if (!request.body) {
      return JSON.parse('');
   }

   const reader = request.body.getReader();
   const chunks: Uint8Array[] = [];
   let totalBytes = 0;
   const deadline =
      timeoutMilliseconds === undefined
         ? undefined
         : performance.now() + timeoutMilliseconds;

   try {
      while (true) {
         const { done, value } = await readChunk(
            reader,
            deadline,
            timeoutMilliseconds,
         );
         if (done) break;

         totalBytes += value.byteLength;
         if (totalBytes > limitBytes) {
            await reader.cancel('request body limit exceeded');
            throw new RequestBodyTooLargeError(limitBytes);
         }

         chunks.push(value);
      }
   } catch (error) {
      if (error instanceof RequestBodyReadTimeoutError) {
         try {
            await reader.cancel('request body read timeout');
         } catch {
            // The timeout result is authoritative even if cancellation races
            // with a transport-level stream failure.
         }
      }
      throw error;
   } finally {
      try {
         reader.releaseLock();
      } catch {
         // A transport may still be unwinding a cancelled read. The request is
         // already rejected and no downstream consumer may reuse this stream.
      }
   }

   const body = new Uint8Array(totalBytes);
   let offset = 0;
   for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
   }

   const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
   return JSON.parse(text);
}

async function readChunk(
   reader: ReadableStreamDefaultReader<Uint8Array>,
   deadline: number | undefined,
   timeoutMilliseconds: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
   if (deadline === undefined || timeoutMilliseconds === undefined) {
      return reader.read();
   }

   const remainingMilliseconds = deadline - performance.now();
   if (remainingMilliseconds <= 0) {
      throw new RequestBodyReadTimeoutError(timeoutMilliseconds);
   }

   let timer: ReturnType<typeof setTimeout> | undefined;
   try {
      return await Promise.race([
         reader.read(),
         new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
               () =>
                  reject(
                     new RequestBodyReadTimeoutError(timeoutMilliseconds),
                  ),
               Math.ceil(remainingMilliseconds),
            );
         }),
      ]);
   } finally {
      if (timer !== undefined) clearTimeout(timer);
   }
}

function parseDeclaredLength(value: string | null): number | undefined {
   if (value === null || value.length === 0) return undefined;
   if (!/^\d+$/.test(value)) return undefined;

   const parsed = Number(value);
   return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
