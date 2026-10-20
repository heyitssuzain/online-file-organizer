/**
 * AuraFlow Web — Category definitions
 *
 * Ported from the desktop application's `enhanced-organizer/source/category_manager.py`
 * (AuraFlow — File Organiser). Extension lists are kept identical to the proven
 * desktop rules so the web edition classifies files the same way.
 *
 * Extensions are used as a *hint* for categorisation, never as proof of content.
 * Unknown extensions go to "Others" rather than being discarded.
 */

export interface Category {
  /** Folder name used on disk. Avoids spaces so it is friendly on every OS. */
  name: string;
  /** Human label shown in the UI. */
  label: string;
  extensions: readonly string[];
  icon: string;
  color: string;
  description: string;
}

export const CATEGORIES: readonly Category[] = [
  {
    name: 'Documents',
    label: 'Documents',
    extensions: [
      '.pdf', '.docx', '.doc', '.txt', '.csv', '.rtf', '.odt', '.md', '.tex',
      '.xls', '.xlsx', '.ppt', '.pptx', '.ods', '.pages', '.numbers', '.key',
    ],
    icon: 'doc',
    color: '#3b82f6',
    description: 'Text documents, spreadsheets, presentations',
  },
  {
    name: 'Images',
    label: 'Images',
    extensions: [
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.tiff',
      '.ico', '.heic', '.avif', '.raw', '.cr2', '.nef', '.arw', '.dng', '.psd',
    ],
    icon: 'image',
    color: '#ec4899',
    description: 'Photos, graphics, illustrations',
  },
  {
    name: 'Videos',
    label: 'Videos',
    extensions: [
      '.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v',
      '.mpeg', '.mpg', '.3gp', '.ogv', '.mts', '.m2ts', '.ts', '.vob',
    ],
    icon: 'video',
    color: '#8b5cf6',
    description: 'Movies, clips, screen recordings',
  },
  {
    name: 'Audio',
    label: 'Audio',
    extensions: [
      '.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.wma', '.opus',
      '.aiff', '.mid', '.midi',
    ],
    icon: 'audio',
    color: '#f59e0b',
    description: 'Music, podcasts, sound effects',
  },
  {
    name: 'Archives',
    label: 'Archives',
    extensions: [
      '.zip', '.rar', '.gz', '.7z', '.bz2', '.tar', '.xz', '.zst',
      '.cab', '.iso',
    ],
    icon: 'archive',
    color: '#10b981',
    description: 'Compressed files, disk images',
  },
  {
    name: 'Code',
    label: 'Code',
    extensions: [
      '.py', '.js', '.ts', '.html', '.css', '.cpp', '.java', '.sh',
      '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.dart', '.vue',
      '.jsx', '.tsx', '.scss', '.less', '.sql', '.yaml', '.yml', '.toml',
      '.ini', '.cfg', '.conf',
    ],
    icon: 'code',
    color: '#06b6d4',
    description: 'Source code, scripts, configs',
  },
  {
    name: 'Executables',
    label: 'Executables',
    extensions: [
      '.exe', '.msi', '.bat', '.bin', '.appimage', '.deb', '.rpm', '.apk',
    ],
    icon: 'app',
    color: '#ef4444',
    description: 'Applications, installers, scripts',
  },
  {
    name: 'Design_3D',
    label: 'Design & 3D',
    extensions: [
      '.ai', '.eps', '.fig', '.sketch', '.blend', '.obj', '.stl', '.fbx',
      '.dae', '.gltf', '.glb',
    ],
    icon: 'design',
    color: '#f97316',
    description: 'Design files, 3D models, vectors',
  },
  {
    name: 'Fonts',
    label: 'Fonts',
    extensions: ['.ttf', '.otf', '.woff', '.woff2', '.eot', '.ttc', '.pfb', '.pfm'],
    icon: 'font',
    color: '#84cc16',
    description: 'Font files, typefaces',
  },
  {
    name: 'Data',
    label: 'Data',
    extensions: ['.db', '.sqlite', '.json', '.xml', '.parquet', '.h5', '.hdf5'],
    icon: 'data',
    color: '#6366f1',
    description: 'Databases, datasets, structured data',
  },
  {
    name: 'Others',
    label: 'Others',
    extensions: [],
    icon: 'other',
    color: '#6b7280',
    description: 'Uncategorised files',
  },
] as const;

const OTHERS = 'Others';

/** Folder names this app creates for the "by type"/"by extension" rules. */
export const CATEGORY_NAMES: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.name));

/** True when a folder name matches one of this app's category folders. */
export function isCategoryFolderName(name: string): boolean {
  return CATEGORY_NAMES.has(name);
}

/** Flat extension → category-name map, built lowercase once (case-insensitive lookup). */
const EXT_MAP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const cat of CATEGORIES) {
    for (const ext of cat.extensions) {
      // First category wins for duplicates (psd appears in Images on desktop; Documents keeps csv etc.)
      if (!m.has(ext)) m.set(ext, cat.name);
    }
  }
  return m;
})();

export function getCategory(name: string): Category {
  return CATEGORIES.find((c) => c.name === name) ?? CATEGORIES[CATEGORIES.length - 1]!;
}

/** Category folder name for a lowercase extension; unknown → "Others" (never discarded). */
export function categoryForExtension(ext: string): string {
  return EXT_MAP.get(ext.toLowerCase()) ?? OTHERS;
}

/** `.PDF`, `.HeiC` … are normalised to lowercase with a leading dot. */
export function normalizeExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return '';
  return filename.slice(idx).toLowerCase();
}

/** True when the file has a real extension that no category knows. */
export function isUnknownExtension(filename: string): boolean {
  const ext = normalizeExtension(filename);
  return ext !== '' && !EXT_MAP.has(ext);
}

export function isKnownExtension(filename: string): boolean {
  const ext = normalizeExtension(filename);
  return ext !== '' && EXT_MAP.has(ext);
}

/** Common temporary / incomplete files — flagged, excluded by default. */
const TEMP_EXTENSIONS: readonly string[] = [
  '.tmp', '.temp', '.crdownload', '.part', '.download', '.partial',
  '.swp', '.swo', '.bak', '.orig', '.old', '.prev', '.log', '~',
];

export function isTempFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return TEMP_EXTENSIONS.some((e) => lower.endsWith(e));
}

/** System / metadata files — excluded by default. */
const SYSTEM_FILES: ReadonlySet<string> = new Set([
  'thumbs.db', 'desktop.ini', '.ds_store', 'ehthumbs.db',
  'autorun.inf', 'iconcache.db', 'ntuser.dat', 'ntuser.ini',
]);

export function isSystemFile(filename: string): boolean {
  return SYSTEM_FILES.has(filename.toLowerCase());
}

/**
 * Wildcard exclusion matching, mirroring the desktop's fnmatch usage.
 * Supports `*` (and `?`) patterns, case-insensitive.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .toLowerCase()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return rx.test(name.toLowerCase());
}
