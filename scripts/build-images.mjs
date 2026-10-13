// One-time image optimization (plan §7a). Output is committed to public/brand/.
// Run: npm run images
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'public', 'brand');
const LOGO = join(root, 'logo philo.png');
const PHOTO = join(root, 'صورة الانبا روفائيل.jpg');
const BG = '#241C17';

mkdirSync(out, { recursive: true });

const logo = (size) => sharp(LOGO).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });

for (const size of [80, 160, 320]) {
  await logo(size).webp({ quality: 85, alphaQuality: 90 }).toFile(join(out, `logo-${size}.webp`));
}
await logo(32).png().toFile(join(out, 'favicon-32.png'));
for (const size of [192, 512]) {
  await logo(size).png({ compressionLevel: 9 }).toFile(join(out, `icon-${size}.png`));
}
// iOS shows transparent areas as black; give the touch icon the page background
await sharp({ create: { width: 180, height: 180, channels: 4, background: BG } })
  .composite([{ input: await logo(164).png().toBuffer(), gravity: 'center' }])
  .png()
  .toFile(join(out, 'apple-touch-icon.png'));

for (const width of [360, 720, 1080]) {
  await sharp(PHOTO).resize({ width }).webp({ quality: 78 }).toFile(join(out, `anba-rofail-${width}.webp`));
}

// Open Graph preview: logo + the two title lines in their two colors
const og = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${BG}"/>
  <text x="650" y="290" text-anchor="end" font-family="Cairo, Segoe UI, Arial, sans-serif"
        font-weight="800" font-size="68" fill="#FFF4DF">اجتماع فيلو فاميلي</text>
  <text x="650" y="385" text-anchor="end" font-family="Cairo, Segoe UI, Arial, sans-serif"
        font-weight="600" font-size="50" fill="#FFB217">بحضور الأنبا روفائيل</text>
</svg>`);
await sharp(og)
  .composite([{ input: await logo(440).png().toBuffer(), left: 700, top: 95 }])
  .png({ compressionLevel: 9, palette: true })
  .toFile(join(out, 'og.png'));

console.log('Images written to public/brand/');
