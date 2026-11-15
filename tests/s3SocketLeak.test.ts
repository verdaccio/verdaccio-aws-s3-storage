import type {Logger} from '@verdaccio/types';

import {createS3Client} from '../src/s3Client';
import S3PackageManager from '../src/s3PackageManager';
import type {S3Config} from '../types';

import http from 'node:http';
import type {AddressInfo, Socket} from 'node:net';
import {describe, test, expect, vi, afterEach} from 'vitest';

const logger: Logger = {
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
  http: vi.fn(),
  trace: vi.fn(),
} as any;

type FakeS3State = {
  /** When true, responses complete immediately with a tiny body. */
  completeFast: boolean;
  /**
   * When true, accept the TCP connection but never write response headers.
   * Models a GetObject that has not resolved yet (abort-before-response).
   */
  stallHeaders: boolean;
};

/**
 * Minimal path-style S3 GetObject stand-in. Holds the response body open so an
 * unreleased socket occupies the keep-alive pool (reproduces the production leak).
 */
function createFakeS3Server(state: FakeS3State): {server: http.Server; sockets: Set<Socket>} {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (state.stallHeaders) {
      // Leave the request hanging with no headers — occupies an agent socket.
      return;
    }
    if (state.completeFast) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '3',
        ETag: '"ok"',
      });
      res.end('ok!');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(50 * 1024 * 1024),
      ETag: '"hold"',
    });
    const interval = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(interval);
        return;
      }
      try {
        res.write(Buffer.alloc(32 * 1024, 1));
      } catch {
        clearInterval(interval);
      }
    }, 5);
    res.on('close', () => clearInterval(interval));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {server, sockets};
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * Only maxSockets is set so the pool exhausts quickly. No connectionTimeout /
 * requestTimeout / socketTimeout — the leak fix must work with SDK-default
 * timeouts (all disabled).
 */
function makeConfig(port: number, maxSockets: number): S3Config {
  return {
    bucket: 'test-bucket',
    keyPrefix: 'prefix/',
    dynamoTableName: 'none',
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    s3ForcePathStyle: true,
    accessKeyId: 'test',
    secretAccessKey: 'test',
    maxSockets,
  } as S3Config;
}

function readUntilEnd(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return Promise.race([
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    }),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('hung — S3 socket pool exhausted')), timeoutMs)
    ),
  ]);
}

describe('S3 socket pool leak (readTarball)', () => {
  const servers: http.Server[] = [];
  const clients: ReturnType<typeof createS3Client>[] = [];
  const openSockets: Set<Socket>[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy();
    }
    for (const sockets of openSockets.splice(0)) {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
  });

  test('destroying concurrent tarball reads releases sockets for later reads', async () => {
    const maxSockets = 2;
    const state: FakeS3State = {completeFast: false, stallHeaders: false};
    const {server, sockets} = createFakeS3Server(state);
    servers.push(server);
    openSockets.push(sockets);
    const port = await listen(server);

    const config = makeConfig(port, maxSockets);
    const s3 = createS3Client(config);
    clients.push(s3);
    const pm = new S3PackageManager(config, 'my-pkg', logger, s3);

    // Fill the keep-alive pool, then destroy the consumer without waiting for the body.
    // Without pipeline()+AbortController this leaves maxSockets held and later reads hang.
    const pending = Array.from({length: maxSockets}, (_, i) => {
      const stream = pm.readTarball(`hold-${i}.tgz`);
      return new Promise<void>((resolve) => {
        stream.on('open', () => {
          stream.destroy();
          resolve();
        });
        stream.on('error', () => resolve());
      });
    });
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 100));

    state.completeFast = true;
    const later = pm.readTarball('final.tgz');
    await expect(readUntilEnd(later, 3000)).resolves.toBe('ok!');
  });

  test('abort before GetObject responds cancels the request and frees the pool', async () => {
    const maxSockets = 2;
    const state: FakeS3State = {completeFast: false, stallHeaders: true};
    const {server, sockets} = createFakeS3Server(state);
    servers.push(server);
    openSockets.push(sockets);
    const port = await listen(server);

    const config = makeConfig(port, maxSockets);
    const s3 = createS3Client(config);
    clients.push(s3);
    const pm = new S3PackageManager(config, 'my-pkg', logger, s3);

    // Abort while send() is still awaiting headers. Without abortSignal the two
    // in-flight GetObjects keep both pool slots forever (server never responds).
    const streams = Array.from({length: maxSockets}, (_, i) => {
      const stream = pm.readTarball(`early-${i}.tgz`);
      stream.on('error', () => undefined);
      return stream;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const stream of streams) {
      stream.abort();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    state.stallHeaders = false;
    state.completeFast = true;
    const later = pm.readTarball('final.tgz');
    await expect(readUntilEnd(later, 3000)).resolves.toBe('ok!');
  });

  test('abort after open releases sockets for later reads', async () => {
    const maxSockets = 2;
    const state: FakeS3State = {completeFast: false, stallHeaders: false};
    const {server, sockets} = createFakeS3Server(state);
    servers.push(server);
    openSockets.push(sockets);
    const port = await listen(server);

    const config = makeConfig(port, maxSockets);
    const s3 = createS3Client(config);
    clients.push(s3);
    const pm = new S3PackageManager(config, 'my-pkg', logger, s3);

    const pending = Array.from({length: maxSockets}, (_, i) => {
      const stream = pm.readTarball(`abort-${i}.tgz`);
      return new Promise<void>((resolve) => {
        stream.on('open', () => {
          stream.abort();
          resolve();
        });
        stream.on('error', () => resolve());
      });
    });
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 100));

    state.completeFast = true;
    const later = pm.readTarball('final.tgz');
    await expect(readUntilEnd(later, 3000)).resolves.toBe('ok!');
  });

  // verdaccio 9 never calls abort(): it aborts the signal it passed to readTarball
  test('aborted signal before GetObject responds cancels the request and frees the pool', async () => {
    const maxSockets = 2;
    const state: FakeS3State = {completeFast: false, stallHeaders: true};
    const {server, sockets} = createFakeS3Server(state);
    servers.push(server);
    openSockets.push(sockets);
    const port = await listen(server);

    const config = makeConfig(port, maxSockets);
    const s3 = createS3Client(config);
    clients.push(s3);
    const pm = new S3PackageManager(config, 'my-pkg', logger, s3);

    const controller = new AbortController();
    const streams = Array.from({length: maxSockets}, (_, i) => {
      const stream = pm.readTarball(`signal-${i}.tgz`, {signal: controller.signal});
      stream.on('error', () => undefined);
      return stream;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    state.stallHeaders = false;
    state.completeFast = true;
    const later = pm.readTarball('final.tgz');
    await expect(readUntilEnd(later, 3000)).resolves.toBe('ok!');
  });

  test('a signal aborted before the read starts never holds a socket', async () => {
    const maxSockets = 1;
    const state: FakeS3State = {completeFast: false, stallHeaders: true};
    const {server, sockets} = createFakeS3Server(state);
    servers.push(server);
    openSockets.push(sockets);
    const port = await listen(server);

    const config = makeConfig(port, maxSockets);
    const s3 = createS3Client(config);
    clients.push(s3);
    const pm = new S3PackageManager(config, 'my-pkg', logger, s3);

    const controller = new AbortController();
    controller.abort();
    const stream = pm.readTarball('gone.tgz', {signal: controller.signal});
    stream.on('error', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(stream.destroyed).toBe(true);
    state.stallHeaders = false;
    state.completeFast = true;
    const later = pm.readTarball('final.tgz');
    await expect(readUntilEnd(later, 3000)).resolves.toBe('ok!');
  });

  test('destroying the stream before GetObject responds cancels the request', async () => {
    const maxSockets = 2;
    const state: FakeS3State = {completeFast: false, stallHeaders: true};
    const {server, sockets} = createFakeS3Server(state);
    servers.push(server);
    openSockets.push(sockets);
    const port = await listen(server);

    const config = makeConfig(port, maxSockets);
    const s3 = createS3Client(config);
    clients.push(s3);
    const pm = new S3PackageManager(config, 'my-pkg', logger, s3);

    const streams = Array.from({length: maxSockets}, (_, i) => {
      const stream = pm.readTarball(`destroyed-${i}.tgz`);
      stream.on('error', () => undefined);
      return stream;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const stream of streams) {
      stream.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    state.stallHeaders = false;
    state.completeFast = true;
    const later = pm.readTarball('final.tgz');
    await expect(readUntilEnd(later, 3000)).resolves.toBe('ok!');
  });

  test('a completed download with a signal leaves the stream and the pool intact', async () => {
    const state: FakeS3State = {completeFast: true, stallHeaders: false};
    const {server, sockets} = createFakeS3Server(state);
    servers.push(server);
    openSockets.push(sockets);
    const port = await listen(server);

    const config = makeConfig(port, 1);
    const s3 = createS3Client(config);
    clients.push(s3);
    const pm = new S3PackageManager(config, 'my-pkg', logger, s3);

    const controller = new AbortController();
    const first = pm.readTarball('first.tgz', {signal: controller.signal});
    await expect(readUntilEnd(first, 3000)).resolves.toBe('ok!');
    // aborting after the download finished must be harmless
    controller.abort();
    const second = pm.readTarball('second.tgz');
    await expect(readUntilEnd(second, 3000)).resolves.toBe('ok!');
  });
});
