export class RequestBodyTooLargeError extends Error {
   constructor(readonly limitBytes: number) {
      super(`Request body exceeds ${limitBytes} bytes`);
      this.name = 'RequestBodyTooLargeError';
   }
}

export const MAX_MCP_REQUEST_BODY_BYTES = 32 * 1024;
export const MAX_WATCH_REQUEST_BODY_BYTES = 8 * 1024;

export async function readJsonBodyWithLimit(
   request: Request,
   limitBytes: number,
): Promise<unknown> {
   if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error('limitBytes must be a positive safe integer');
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

   try {
      while (true) {
         const { done, value } = await reader.read();
         if (done) break;

         totalBytes += value.byteLength;
         if (totalBytes > limitBytes) {
            await reader.cancel('request body limit exceeded');
            throw new RequestBodyTooLargeError(limitBytes);
         }

         chunks.push(value);
      }
   } finally {
      reader.releaseLock();
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

function parseDeclaredLength(value: string | null): number | undefined {
   if (value === null || value.length === 0) return undefined;
   if (!/^\d+$/.test(value)) return undefined;

   const parsed = Number(value);
   return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
