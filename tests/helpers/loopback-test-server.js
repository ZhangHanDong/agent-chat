import { createServer } from 'node:http';

// Supertest's request(expressApp) binds a wildcard listener, then connects to
// 127.0.0.1. On macOS that port can already belong to another IPv4 listener.
// Await the exact address the client will use before handing it the server.
export async function createLoopbackTestServer(app, { host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  let closing;
  return {
    server,
    baseUrl: `http://${urlHost}:${address.port}`,
    close() {
      if (!closing) {
        closing = new Promise((resolve, reject) => {
          server.close((error) => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
