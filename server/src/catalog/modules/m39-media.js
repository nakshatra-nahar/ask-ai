import { defineModule, ops, z, id, entity, isoDate, fail } from '../kit.js';

const MAX_BYTES = 50 * 1024 * 1024;
const TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image', 'image/svg+xml': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video', 'audio/mpeg': 'audio',
  'application/pdf': 'document', 'text/csv': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
};
const KINDS = ['image', 'video', 'audio', 'document'];
const CDN = 'https://cdn.askai-media.test/assets';
// Tables whose rows may embed an asset id/url; scanned by List asset references and Delete unreferenced asset.
const SKIP = new Set(['media', 'activity']);

const asset = entity({
  name: z.string(), mimeType: z.string(), kind: z.enum(KINDS), sizeBytes: z.number(), folder: z.string(), url: z.string(),
  altText: z.string().nullable(), version: z.number(), versions: z.array(z.looseObject({ version: z.number(), mimeType: z.string(), sizeBytes: z.number() })),
  uploadedBy: z.string().nullable(),
});

const ext = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');
const normFolder = (f) => '/' + f.split('/').map((s) => s.trim()).filter(Boolean).join('/');
const byName = (ctx, n) => ctx.all('media').find((m) => m.name === n);
const fileName = z.string().min(1).max(120).regex(/^[^/\\]+\.[A-Za-z0-9]{2,5}$/, 'name must be a file name with an extension, e.g. hero.jpg');
const folderPath = z.string().min(1).max(100).regex(/^[\w\- /]+$/, 'folder may contain letters, digits, spaces, - and /').describe('folder path, e.g. /blog/2026');

function checkFile(mimeType, sizeBytes) {
  if (!TYPES[mimeType]) fail('VALIDATION', `unsupported file type '${mimeType}'; allowed: ${Object.keys(TYPES).join(', ')}`);
  if (sizeBytes > MAX_BYTES) fail('LIMIT_EXCEEDED', `file is ${(sizeBytes / 1048576).toFixed(1)} MB; the maximum is 50 MB`);
}
function uniqueInFolder(ctx, name, folder, selfId) {
  const dup = ctx.all('media').find((m) => m.id !== selfId && m.folder === folder && m.name.toLowerCase() === name.toLowerCase());
  if (dup) fail('DUPLICATE', `folder ${folder} already contains '${dup.name}' (${dup.id}); pick another name or folder`, { existingId: dup.id });
}
function references(ctx, a) {
  const re = new RegExp(`\\b${a.id}\\b`); // asset url embeds the id, so this catches both
  const refs = [];
  for (const [table, rows] of Object.entries(ctx.db.tables)) {
    if (SKIP.has(table)) continue;
    for (const r of rows)
      for (const [field, v] of Object.entries(r))
        if (field !== 'id' && v != null && re.test(typeof v === 'string' ? v : JSON.stringify(v)))
          refs.push({ table, recordId: r.id, label: r.name || r.title || r.id, field });
  }
  return refs;
}

export default defineModule({
  id: 'media',
  code: 'M39',
  name: 'Media Assets',
  description: 'Store and organize images and downloadable files.',
  tables: { media: { prefix: 'med', schema: asset } },
  actions: [
    {
      id: 'upload_media', name: 'Upload media asset',
      description: 'Add a file (image, video, audio, PDF/office document) to the media library in a folder. Max 50 MB; names must be unique per folder. Returns the hosted CDN url.',
      keywords: ['upload image', 'add file', 'store asset'],
      risk: 'write',
      input: z.object({
        name: fileName, mimeType: z.string().min(3).describe('MIME type, e.g. image/jpeg, application/pdf'),
        sizeBytes: z.number().int().positive(), folder: folderPath.optional(), altText: z.string().max(250).optional().describe('images only'),
      }),
      output: asset,
      handler: (i, ctx) => {
        checkFile(i.mimeType, i.sizeBytes);
        const kind = TYPES[i.mimeType];
        if (i.altText && kind !== 'image') fail('VALIDATION', `altText only applies to images; '${i.name}' is a ${kind}`);
        const folder = normFolder(i.folder || '/');
        uniqueInFolder(ctx, i.name, folder);
        const rec = ctx.insert('media', {
          name: i.name, mimeType: i.mimeType, kind, sizeBytes: i.sizeBytes, folder, altText: i.altText ?? null,
          version: 1, versions: [{ version: 1, mimeType: i.mimeType, sizeBytes: i.sizeBytes, uploadedAt: ctx.now }], uploadedBy: ctx.actorId,
        });
        return ctx.patch(rec, { url: `${CDN}/${rec.id}` });
      },
      example: () => ({ name: 'spring-promo-banner.png', mimeType: 'image/png', sizeBytes: 845000, folder: '/websites/dental', altText: 'Spring whitening promo banner' }),
    },
    {
      id: 'get_media', name: 'Get asset metadata',
      description: 'Fetch one media asset by ID: name, type, size, folder, CDN url, alt text and version history.',
      ...ops.get('media', { what: 'media asset' }),
      example: (ctx) => ({ id: byName(ctx, 'bright-smile-hero.jpg').id }),
    },
    {
      id: 'search_media', name: 'Search media assets',
      description: 'Find media assets by name/alt-text, kind (image/video/audio/document), folder, MIME type, size range, or upload date range.',
      keywords: ['find image', 'browse files', 'media library'],
      ...ops.search('media', {
        text: ['name', 'altText'],
        filters: {
          kind: z.enum(KINDS).optional(), folder: z.string().optional().describe('exact folder path, e.g. /blog'), mimeType: z.string().optional(),
          sizeBytesMin: z.number().optional(), sizeBytesMax: z.number().optional(), createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        },
        // folder is compared normalized ('blog/' finds '/blog'), like stored folders
        virtual: ['folder'],
        where: (r, i) => !i.folder || r.folder.toLowerCase() === normFolder(i.folder).toLowerCase(),
      }),
      example: () => ({ kind: 'image' }),
    },
    {
      id: 'rename_media', name: 'Rename media asset',
      description: 'Change a media asset\'s file name (keeps id and url, so references stay valid). The extension cannot change — use Replace asset file for a different format.',
      ...ops.set('media', 'name', fileName, {
        what: 'media asset',
        guard: (rec, i, ctx) => {
          if (ext(i.name) !== ext(rec.name)) fail('VALIDATION', `extension must stay .${ext(rec.name)} (got .${ext(i.name)}); use Replace asset file to change format`);
          uniqueInFolder(ctx, i.name, rec.folder, rec.id);
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'team-photo-2026.jpg').id, name: 'bright-smile-team-2026.jpg' }),
    },
    {
      id: 'set_media_alt_text', name: 'Set asset alt text',
      description: 'Set the accessibility alt text of an image asset (max 250 chars). Rejected for videos, audio and documents.',
      keywords: ['alt tag', 'accessibility', 'image description'],
      ...ops.set('media', 'altText', z.string().trim().min(1).max(250), {
        what: 'media asset',
        guard: (rec) => {
          if (rec.kind !== 'image') fail('INVALID_STATE', `asset ${rec.id} '${rec.name}' is a ${rec.kind}; alt text applies to images only`);
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'team-photo-2026.jpg').id, altText: 'The Bright Smile Dental team in front of the clinic' }),
    },
    {
      id: 'move_media', name: 'Move asset to folder',
      description: 'Move a media asset to another folder (created implicitly). The url does not change. Fails if the target folder already has a file with the same name.',
      keywords: ['organize', 'file into folder'],
      ...ops.set('media', 'folder', folderPath, {
        what: 'media asset', map: normFolder,
        guard: (rec, i, ctx) => {
          const to = normFolder(i.folder);
          if (to === rec.folder) fail('VALIDATION', `asset ${rec.id} is already in ${to}`);
          uniqueInFolder(ctx, rec.name, to, rec.id);
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'old-logo-2023.png').id, folder: '/brand/logos' }),
    },
    {
      id: 'replace_media_file', name: 'Replace asset file',
      description: 'Upload a new file version in place of an existing asset: same id and url, version +1, history kept. The new file must be the same kind (image→image) and ≤50 MB.',
      keywords: ['swap image', 'new version', 'update file'],
      risk: 'write',
      input: z.object({
        id: id('media asset'), mimeType: z.string().min(3), sizeBytes: z.number().int().positive(),
        name: fileName.optional().describe('new file name if the extension changes'),
      }),
      output: asset,
      handler: ({ id: mid, mimeType, sizeBytes, name }, ctx) => {
        const a = ctx.get('media', mid, 'media asset');
        checkFile(mimeType, sizeBytes);
        if (TYPES[mimeType] !== a.kind) fail('VALIDATION', `asset ${a.id} is of kind ${a.kind}; replacement must also be ${a.kind} (got ${mimeType})`);
        if (name) uniqueInFolder(ctx, name, a.folder, a.id);
        const version = a.version + 1;
        return ctx.patch(a, {
          mimeType, sizeBytes, version, ...(name ? { name } : {}),
          versions: [...a.versions, { version, mimeType, sizeBytes, uploadedAt: ctx.now, uploadedBy: ctx.actorId }],
        });
      },
      example: (ctx) => ({ id: byName(ctx, 'bright-smile-hero.jpg').id, mimeType: 'image/jpeg', sizeBytes: 1320000 }),
    },
    {
      id: 'list_media_references', name: 'List asset references',
      description: 'Show every record (landing page sections, blog featured images, website SEO, course lessons, etc.) that uses a media asset\'s id or url. Check before deleting or replacing.',
      keywords: ['where used', 'usage', 'dependencies'],
      risk: 'read',
      input: z.object({ id: id('media asset') }),
      output: z.looseObject({ assetId: z.string(), total: z.number(), items: z.array(z.looseObject({ table: z.string(), recordId: z.string(), field: z.string() })) }),
      handler: ({ id: mid }, ctx) => {
        const a = ctx.get('media', mid, 'media asset');
        const items = references(ctx, a);
        return { assetId: a.id, name: a.name, url: a.url, total: items.length, items };
      },
      example: (ctx) => ({ id: byName(ctx, 'bright-smile-hero.jpg').id }),
    },
    {
      id: 'create_media_access_link', name: 'Generate asset access link',
      description: 'Create a signed, expiring download link for a media asset (1-168 hours) that works for people outside the account.',
      keywords: ['share file', 'signed url', 'download link'],
      risk: 'external',
      input: z.object({ id: id('media asset'), expiresInHours: z.number().int().min(1).max(168).default(24).describe('link lifetime, 1-168 hours') }),
      output: z.looseObject({ assetId: z.string(), url: z.string(), expiresAt: z.string() }),
      handler: ({ id: mid, expiresInHours }, ctx) => {
        const a = ctx.get('media', mid, 'media asset');
        const expiresAt = new Date(Date.parse(ctx.now) + expiresInHours * 36e5).toISOString();
        const token = ctx.newId('mlnk');
        const sig = [...`${a.id}|${expiresAt}|${token}`].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
        const link = { token, expiresAt, createdBy: ctx.actorId, createdAt: ctx.now };
        ctx.patch(a, { accessLinks: [...(a.accessLinks || []), link] });
        return { assetId: a.id, name: a.name, url: `${a.url}?token=${token}&expires=${Date.parse(expiresAt) / 1000}&sig=${sig}`, expiresAt };
      },
      example: (ctx) => ({ id: byName(ctx, 'meal-plan-guide.pdf').id, expiresInHours: 72 }),
    },
    {
      id: 'delete_media', name: 'Delete unreferenced asset',
      description: 'Permanently delete a media asset and its file. Refused (CONFLICT, listing the references) if any page, post, website or lesson still uses it.',
      keywords: ['remove file', 'delete image', 'cleanup media'],
      risk: 'destructive',
      input: z.object({ id: id('media asset') }),
      output: asset,
      handler: ({ id: mid }, ctx) => {
        const a = ctx.get('media', mid, 'media asset');
        const refs = references(ctx, a);
        if (refs.length)
          fail('CONFLICT', `asset ${a.id} '${a.name}' is still used by ${refs.length} record(s): ${refs.map((r) => `${r.table} ${r.recordId} (${r.field})`).join(', ')}; remove those references first`, { references: refs });
        return ctx.remove('media', a.id);
      },
      example: (ctx) => ({ id: byName(ctx, 'old-logo-2023.png').id }),
    },
  ],

  // Runs after websites/landing_pages/blogs, so it wires a few references into them.
  seed(ctx, h) {
    const files = [
      ['bright-smile-hero.jpg', 'image/jpeg', 1_180_000, '/websites/dental', 'Smiling patient in the Bright Smile Dental chair'],
      ['invisalign-before-after.webp', 'image/webp', 410_000, '/blog', 'Before and after Invisalign treatment'],
      ['summit-hiit-class.jpg', 'image/jpeg', 2_300_000, '/blog', 'HIIT class at Summit Fitness Studio'],
      ['meal-plan-guide.pdf', 'application/pdf', 3_400_000, '/downloads', null],
      ['masterclass-promo.mp4', 'video/mp4', 48_500_000, '/videos', null],
      ['old-logo-2023.png', 'image/png', 96_000, '/brand/archive', 'Old Bright Smile logo'],
      ['team-photo-2026.jpg', 'image/jpeg', 2_900_000, '/websites/dental', null],
      ['class-schedule-nov.pdf', 'application/pdf', 220_000, '/downloads', null],
      ['spa-ambience.jpg', 'image/jpeg', 1_650_000, '/websites/spa', 'Candle-lit treatment room'],
    ];
    const m = {};
    files.forEach(([name, mimeType, sizeBytes, folder, altText], i) => {
      const createdAt = h.daysAgo(120 - i * 9);
      const rec = ctx.insert('media', {
        name, mimeType, kind: TYPES[mimeType], sizeBytes, folder, altText, version: 1,
        versions: [{ version: 1, mimeType, sizeBytes, uploadedAt: createdAt }], uploadedBy: 'usr_008', createdAt, updatedAt: createdAt,
      });
      rec.url = `${CDN}/${rec.id}`;
      m[name] = rec;
    });
    // References: hero → landing page + website og image; blog images → posts; PDF → download page; video → replay page.
    const lp = (n) => ctx.all('landing_pages').find((p) => p.name === n);
    const setMedia = (page, type, url) => { const s = page?.sections.find((x) => x.type === type); if (s) s.mediaUrl = url; };
    setMedia(lp('New Patient Cleaning Offer'), 'hero', m['bright-smile-hero.jpg'].url);
    setMedia(lp('Meal Plan Download'), 'download', m['meal-plan-guide.pdf'].url);
    setMedia(lp('Masterclass Replay Offer'), 'video', m['masterclass-promo.mp4'].url);
    const site = ctx.all('websites').find((w) => w.name === 'Bright Smile Dental');
    if (site?.seo) site.seo.ogImage = m['bright-smile-hero.jpg'].url;
    const post = (t) => ctx.all('blog_posts').find((p) => p.title === t);
    const p1 = post('Invisalign vs. Braces: Which Is Right for You?');
    if (p1) p1.featuredImage = m['invisalign-before-after.webp'].id;
    const p2 = post('HIIT vs. Steady-State Cardio: What Burns More?');
    if (p2) p2.featuredImage = m['summit-hiit-class.jpg'].url;
  },
});
