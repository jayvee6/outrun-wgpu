import { defineConfig } from 'vite';
import { writeFileSync } from 'node:fs';

// Dev-only screenshot sink: the page POSTs offscreen-probe PNGs to /__shot and
// they land on disk, so headless verification can Read the rendered frame
// without piping a huge base64 string back through the eval channel.
export default defineConfig({
  server: { port: 5210, host: true, strictPort: true },
  plugins: [
    {
      name: 'outrun-shot-sink',
      configureServer(server) {
        server.middlewares.use('/__shot', (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'shot')
            .replace(/[^a-z0-9_-]/gi, '');
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            try {
              writeFileSync(`/tmp/outrun_${name}.png`, Buffer.concat(chunks));
              res.end('ok');
            } catch (e) { res.statusCode = 500; res.end(String(e)); }
          });
        });
      },
    },
  ],
});
