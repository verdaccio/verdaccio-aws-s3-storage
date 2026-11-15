/**
 * Release an S3 GetObject response body so the NodeHttpHandler socket
 * returns to the keep-alive pool. No-op when the body was already consumed
 * or destroyed.
 *
 * @see https://github.com/aws/aws-sdk-js-v3/issues/6691
 */
export function destroyS3Body(body: unknown): void {
  if (
    body &&
    typeof body === 'object' &&
    'destroy' in body &&
    typeof (body as {destroy?: unknown}).destroy === 'function' &&
    !(
      (body as {destroyed?: boolean}).destroyed || (body as {readableEnded?: boolean}).readableEnded
    )
  ) {
    (body as {destroy: (err?: Error) => void}).destroy();
  }
}
