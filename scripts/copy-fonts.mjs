// Copies the Cairo woff2 subsets we use (Arabic + Latin, 400/600/800) to public/fonts/.
// Run: npm run fonts
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = join(root, 'node_modules', '@fontsource', 'cairo', 'files');
const out = join(root, 'public', 'fonts');
mkdirSync(out, { recursive: true });

for (const subset of ['arabic', 'latin']) {
  for (const weight of [400, 600, 800]) {
    const file = `cairo-${subset}-${weight}-normal.woff2`;
    copyFileSync(join(src, file), join(out, file));
  }
}
console.log('Fonts copied to public/fonts/');
