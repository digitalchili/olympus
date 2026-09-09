import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../../client/vite.config';

export default mergeConfig(base, {
  root: fileURLToPath(new URL('../../', import.meta.url)),
  css: { postcss: fileURLToPath(new URL('../../client', import.meta.url)) },
  server: { host: '127.0.0.1', port: 4183 },
});
